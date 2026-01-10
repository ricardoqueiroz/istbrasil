const db = require('./src/config/db');

async function check() {
    try {
        const [rows] = await db.execute('DESCRIBE ist_releases');
        console.log(JSON.stringify(rows.map(r => r.Field), null, 2));
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

check();
