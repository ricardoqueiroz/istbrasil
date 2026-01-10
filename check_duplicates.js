const db = require('./src/config/db');

async function check() {
    try {
        const [rows] = await db.execute('SELECT release_num, COUNT(*) as c FROM ist_releases GROUP BY release_num HAVING c > 1');
        console.log('Duplicates:', rows);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

check();
