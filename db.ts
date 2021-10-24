import { mkdirSync, chmodSync } from 'fs';
import { dirname } from 'path';
import Sqlite from 'better-sqlite3';
import Message from './message';

export default class Database {
    db          : Sqlite.Database;
    seenSelect  : Sqlite.Statement;
    seenInsert  : Sqlite.Statement;
    attrSelect  : Sqlite.Statement;
    attrReplace : Sqlite.Statement;
    queueInsert : Sqlite.Statement;
    queueDelete : Sqlite.Statement;
    queueSelect : Sqlite.Statement;

    constructor(filename: string) {
        // Create the directory for database files. Set the permissions to 1777
        // to make sure that we can create files in the directory after dropping
        // privileges (switching users). The directory will have the same
        // permissions as /tmp, i.e., everybody will be able to write, but only
        // the owner will be able to delete the files.
        const dir = dirname(filename);
        mkdirSync(dir, { recursive: true });
        chmodSync(dir, 0o1777);

        this.db = new Sqlite(filename);
        this.createTables();

        this.seenSelect = this.db.prepare('SELECT * FROM seen WHERE id=?');
        this.seenInsert = this.db.prepare('INSERT INTO seen (id) VALUES (?)');

        this.attrSelect = this.db.prepare('SELECT value FROM attrs WHERE name=?');
        this.attrReplace = this.db.prepare('REPLACE INTO attrs (name, value) VALUES (?, ?)');

        this.queueInsert = this.db.prepare('INSERT INTO queue (messageId, message) VALUES (?, ?)');
        this.queueDelete = this.db.prepare('DELETE FROM queue WHERE messageId=?');
        this.queueSelect = this.db.prepare('SELECT message FROM queue');
    }

    createTables() {
        this.db.exec("CREATE TABLE IF NOT EXISTS attrs (\n\
    name  TEXT NOT NULL,                                \n\
    value TEXT DEFAULT NULL);                           \n\
    CREATE UNIQUE INDEX IF NOT EXISTS attrIndex ON attrs(name);");

        this.db.exec("CREATE TABLE IF NOT EXISTS seen (\n\
    id TEXT NOT NULL);                                 \n\
    CREATE UNIQUE INDEX IF NOT EXISTS seenIndex ON seen(id);");

        this.db.exec("CREATE TABLE IF NOT EXISTS queue (\n\
    id        INTEGER PRIMARY KEY,                      \n\
    messageId TEXT NOT NULL,                            \n\
    message   TEXT NOT NULL);                           \n\
    CREATE UNIQUE INDEX IF NOT EXISTS queueIndex ON queue(messageId);");
    }

    isSeen(id: string) {
        return this.seenSelect.get(id) !== undefined;
    }

    setSeen(id: string) {
        this.seenInsert.run(id);
    }

    get(name: string) {
        return (this.attrSelect.get(name) || {}).value;
    }

    set(name: string, value?: string) {
        this.attrReplace.run(name, value === undefined ? null : value);
    }

    enqueue(msg: Message) {
        this.queueInsert.run(msg.id, JSON.stringify(msg));
    }

    dequeue(msg: Message) {
        this.queueDelete.run(msg.id);
    }

    getMessages() {
        return this.queueSelect.all().map(row => JSON.parse(row.message));
    }
}