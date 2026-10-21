import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const host=process.env.IST_D74_BACKEND_HOST;assert.match(host??'',/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.1$/);
const conf=await readFile(new URL('../nginx.conf',import.meta.url),'utf8');
const protegido=conf.match(/location ~ \^\/loja\/\(recuperar\|biblioteca\/confirmar\)\/\?\$ \{[\s\S]*?\n        \}/)?.[0];
assert(protegido);
process.stdout.write(`pid /tmp/nginx.pid; events {worker_connections 64;} http { include /etc/nginx/mime.types;
    server {listen 8080 ssl; root /usr/share/nginx/html; index index.html;
    ssl_certificate /run/test/cert.pem; ssl_certificate_key /run/test/key.pem;
    location /api/ {proxy_pass http://${host}:13382; proxy_set_header Host $http_host; proxy_set_header X-Forwarded-Proto https;}
    ${protegido}
    location / {try_files $uri $uri/ /index.html;}
    }}
`);
