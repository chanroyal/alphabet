const express = require('express')
const bodyParser = require('body-parser')
const pug = require('pug');
const randomstring = require("randomstring");
const sqlite3 = require('sqlite3');

const port = 8080

// initialize sqlite DB tables and indexes
var db = new sqlite3.Database('alphabet.db');
db.serialize(function() {
    db.run("CREATE TABLE IF NOT EXISTS games (" + 
        "name VARCHAR(128) NOT NULL, " + 
        "guessesLeft INT NOT NULL, " +
        "currentString VARCHAR(256) NOT NULL, " + 
        "currentCorrectCount INT NOT NULL, " +
        "token CHAR(40) NOT NULL UNIQUE)");
    db.run("CREATE INDEX IF NOT EXISTS idx_token ON games (token)");

    db.run("CREATE TABLE IF NOT EXISTS scoreboard (" + 
        "name VARCHAR(128) NOT NULL UNIQUE, " + 
        "score INT NOT NULL)");
    db.run("CREATE INDEX IF NOT EXISTS idx_score ON scoreboard (score)");

    var beginner = "'---------BEGINNER---------'";
    var intermed = "'-------INTERMEDIATE-------'";
    var advanced = "'---------ADVANCED---------'";
    var expert   = "'----------EXPERT----------'";

    db.run(`INSERT INTO scoreboard (name, score) VALUES (${beginner}, 500 ) ON CONFLICT(name) DO UPDATE SET score=500  WHERE name=${beginner}`);
    db.run(`INSERT INTO scoreboard (name, score) VALUES (${intermed}, 1000) ON CONFLICT(name) DO UPDATE SET score=1000 WHERE name=${intermed}`);
    db.run(`INSERT INTO scoreboard (name, score) VALUES (${advanced}, 1500) ON CONFLICT(name) DO UPDATE SET score=1500 WHERE name=${advanced}`);
    db.run(`INSERT INTO scoreboard (name, score) VALUES (${expert},   2000) ON CONFLICT(name) DO UPDATE SET score=2000 WHERE name=${expert}`);
});
db.close();

function newScore(name, score) {
    var db = new sqlite3.Database('alphabet.db');
    var sql = "INSERT INTO scoreboard (name, score) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET score=? WHERE name=? and score<?";
    db.all(sql, [name, score, score, name, score], (err, rows) => {
        db.close();
        if (err) {
            throw err;
        }
    });
}

const app = express()
app.use(bodyParser.json())

app.get('/alphabet', (request, response) => {
    var db = new sqlite3.Database('alphabet.db', sqlite3.OPEN_READONLY);
    var sql = "SELECT * FROM scoreboard ORDER BY score DESC LIMIT 30";

    db.all(sql, [], (err, rows) => {
        db.close();
        if (err) {
            response.send("UNKNOWN ERROR");
            throw err;
        }
        var options = {
            "scoreboard" : rows
        }
        var html = pug.renderFile('index.pug', options);
        response.send(html);
    });
})

function generateNewToken() {
    return randomstring.generate(40);
}

function nextLength(prevLength) {
    return prevLength >= 10 ? prevLength + 4 : prevLength + 2;
}

function newSecretString(len) {
    return randomstring.generate({
        length: len,
        charset: 'alphabetic',
        capitalization: 'lowercase'
    })
}

const alphaNumericUnderscoreSpace = /^[a-zA-Z0-9_ ]+$/;

function startNewGame(name, response) {
    var db = new sqlite3.Database('alphabet.db');
    var sql = "INSERT INTO games (name, guessesLeft, currentString, currentCorrectCount, token) values (?, ?, ?, ?, ?)";

    var guessesLeft = 5000;
    var secret = newSecretString(2);
    var token = generateNewToken();

    db.run(sql, [name, guessesLeft, secret, 0, token], (err) => {
        db.close();
        if (err) {
            response.json({ "error" : "Unknown error starting game, please try again." })
            throw err;
        }
        response.json({
            "token" : token,
            "length": secret.length,
            "guessesLeft" : guessesLeft
        });
    });
}

app.post('/alphabet/startgame', (request, response) => {
    if (!request.body) {
        response.json({ "error" : "Missing POST body." })
    } else if (!request.body.name) {
        response.json({ "error" : "Need to provide a 'name'." })
    } else if (!request.body.name.match(alphaNumericUnderscoreSpace)) {
        response.json({ "error" : "'name' must be alphanumeric, spaces and underscores allowed" })
    } else {
        startNewGame(request.body.name, response)
    }
})

function getNumberCharactersMatched(secret, guess) {
    var count = 0;
    for (var i = 0; i < secret.length; ++i) {
        if (secret.charAt(i) == guess.charAt(i)) {
            ++count;
        }
    }
    return count;
}

function getScore(currentSecretLength, lettersCorrect) {
    // probably a smarter formula to do this in constant time...
    var i = 2;
    var totalScore = 0;
    while (i < currentSecretLength) {
        totalScore += i;
        i = nextLength(i);
    }
    return totalScore + lettersCorrect;
}

function tryHighScoreEntry(db, row, lettersCorrect) {
    if (row.guessesLeft == 1) { // in-memory row not decremented yet
        var score = getScore(row.currentString.length, Math.max(lettersCorrect, row.currentCorrectCount));
        var sql = "INSERT INTO scoreboard (name, score) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET score=? WHERE name=? AND score<?";

        db.run(sql, [row.name, score, score, row.name, score], (err) => {
            db.close();
            if (err) {
                throw err; // RIP Highscore
            }
            console.log(`${row.name} completed the game with score: ${score}`)
        });
    } else {
        db.close();
    }
}

const allLowercaseRegex = /^[a-z]+$/;

function makeGuess(token, guess, response) {
    var db = new sqlite3.Database('alphabet.db');
    var sqlGet = "SELECT * FROM games WHERE token=?";
    var sqlUpdateGuess = "UPDATE games SET guessesLeft=?, currentCorrectCount=?, token=? WHERE token=?";
    var sqlUpdateNewSecret = "UPDATE games SET guessesLeft=?, currentString=?, currentCorrectCount=0, token=? WHERE token=?";

    db.get(sqlGet, [token], (err, row) => {
        if (err) {
            response.json({ "error" : "Unknown error making guess, please try again." })
            db.close();
            throw err;
        }

        if (!row) {
            response.json({ "error" : "Could not find a matching game in progress." })
        } else if (row.guessesLeft == 0) {
            response.json({ "error" : "No more guesses left, game is over." })
        } else if (guess.length != row.currentString.length) {
            response.json({ "error" : "Guess does not match secret length." })
        } else if (!guess.match(allLowercaseRegex)) {
            response.json({ "error" : "Guess must be all lowercase alphebetic characters." })
        } else {
            var lettersCorrect = getNumberCharactersMatched(row.currentString, guess);
            var guessesLeft = row.guessesLeft - 1;
            var newToken = generateNewToken();

            console.log(`${row.name} got ${lettersCorrect}/${row.currentString.length} with guess: ${guess}`);

            if (lettersCorrect == row.currentString.length) {
                var maxCorrectCount = 0;
                var secret = newSecretString(nextLength(row.currentString.length));

                db.run(sqlUpdateNewSecret, [guessesLeft, secret, newToken, token], (err) => {
                    if (err) {
                        response.json({ "error" : "Unknown error persisting guess, please try again." })
                        throw err;
                    }

                    response.json({
                        "token" : newToken,
                        "length": secret.length,
                        "guessesLeft" : guessesLeft,
                        "lettersCorrect" : 0
                    });
                    tryHighScoreEntry(db, row, lettersCorrect);
                })
            } else {
                var maxCorrectCount = Math.max(row.currentCorrectCount, lettersCorrect)
                db.run(sqlUpdateGuess, [guessesLeft, maxCorrectCount, newToken, token], (err) => {
                    if (err) {
                        response.json({ "error" : "Unknown error persisting guess, please try again." })
                        throw err;
                    }

                    response.json({
                        "token" : newToken,
                        "length": row.currentString.length,
                        "guessesLeft" : guessesLeft,
                        "lettersCorrect" : lettersCorrect
                    });
                    tryHighScoreEntry(db, row, lettersCorrect);
                })
            }
        }
    });
}

app.post('/alphabet/guess', (request, response) => {
    if (!request.body) {
        response.json({ "error" : "Missing POST body." })
    } else if (!request.body.token) {
        response.json({ "error" : "Need to provide a 'token'." })
    } else if (!request.body.guess) {
        response.json({ "error" : "Need to provide a 'guess'." })
    } else {
        makeGuess(request.body.token, request.body.guess, response)
    }
})

app.listen(port, (err) => {
    if (err) {
        return console.log('Error: ', err)
    }

    console.log(`alphabet running on port:${port}`)
})