const http = require('http');

http.get('http://localhost:3000/api/releases', (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            if (json.length > 0) {
                console.log('Sample item:', JSON.stringify(json[0], null, 2));
            } else {
                console.log('Empty array');
            }
        } catch (e) {
            console.error('JSON Error:', e.message);
            console.log('Raw Data partial:', data.substring(0, 100));
        }
    });
}).on('error', (err) => {
    console.error('Error:', err.message);
});
