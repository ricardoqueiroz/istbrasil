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

exports.getReleaseTracks = async (req, res) => {
    try {
        const releaseNum = req.params.releaseNum;
        
        // Buscamos as faixas ordenadas pela posição (A1, A2, B1...) ou id
        const query = `
            SELECT id, position, duration, titulo 
            FROM ist_tracks 
            WHERE release_num = ? 
            ORDER BY position ASC, id ASC
        `;
        
        const [rows] = await db.execute(query, [releaseNum]);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Error fetching tracks:', error);
        res.status(500).json({
            message: 'Error fetching tracks.',
            error: error.message
        });
    }
};
