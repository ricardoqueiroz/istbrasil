const http = require('http');

http.get('http://localhost:3000/api/releases', (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            if (json.length > 0) {
                console.log('Keys:', Object.keys(json[0]));
            } else {
                console.log('Empty array');
            }
        } catch (e) {
            console.error(e.message);
        }
    });
}).on('error', (err) => {
    console.error('Error:', err.message);
});
