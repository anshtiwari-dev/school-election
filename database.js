
const Datastore = require('nedb-promises');
const path = require('path');

const parties = Datastore.create({ filename: path.join(__dirname, 'data/parties.db'), autoload: true });
const boothSessions = Datastore.create({ filename: path.join(__dirname, 'data/boothSessions.db'), autoload: true });
const voters = Datastore.create({ filename: path.join(__dirname, 'data/voters.db'), autoload: true });
const votes = Datastore.create({ filename: path.join(__dirname, 'data/votes.db'), autoload: true });
const staff = Datastore.create({ filename: path.join(__dirname, 'data/staff.db'), autoload: true });
const historyArchive = Datastore.create({ filename: path.join(__dirname, 'data/historyArchive.db'), autoload: true });
const schedules = Datastore.create({ filename: path.join(__dirname, 'data/schedules.db'), autoload: true });
const systemHistory = Datastore.create({ filename: path.join(__dirname, 'data/systemHistory.db'), autoload: true });

module.exports = {
    parties,
    boothSessions,
    voters,
    votes,
    staff,
    historyArchive,
    schedules,
    systemHistory
};
