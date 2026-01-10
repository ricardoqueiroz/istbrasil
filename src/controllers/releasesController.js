const db = require('../config/db');

exports.getAllReleases = async (req, res) => {
    try {
        const query = `SELECT * FROM ist_releases ORDER BY year ASC`;
        const [rows] = await db.execute(query);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Error in ReleasesController:', error);
        res.status(500).json({
            message: 'Error fetching discography.',
            error: error.message
        });
    }
};
