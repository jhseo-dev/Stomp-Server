const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));

// STOMP destination별 구독자 관리
const subscriptions = {}; // { destination: Set<ws> }

// STOMP 프레임 파서
function parseStompFrame(data) {
    // STOMP 프레임은 \n으로 구분, 마지막은 \0 (null)
    const str = data.toString();
    const [headerPart, ...bodyParts] = str.split('\n\n');
    const headerLines = headerPart.split('\n');
    const command = headerLines[0];
    const headers = {};
    for (let i = 1; i < headerLines.length; i++) {
        const idx = headerLines[i].indexOf(':');
        if (idx > 0) {
            const key = headerLines[i].slice(0, idx).trim();
            const value = headerLines[i].slice(idx + 1).trim();
            headers[key] = value;
        }
    }
    // body는 null 문자(\0)로 끝남
    let body = bodyParts.join('\n\n');
    if (body.endsWith('\0')) body = body.slice(0, -1);
    return { command, headers, body };
}

function buildStompFrame(command, headers = {}, body = '') {
    let frame = command + '\n';
    for (const key in headers) {
        frame += `${key}:${headers[key]}\n`;
    }
    frame += '\n';
    frame += body;
    frame += '\0';
    return frame;
}

// 관리자 메시지 전송 함수 (STOMP SEND 프레임 사용)
function sendAdminMessage(message) {
    const dest = '/topic/chat';
    if (subscriptions[dest]) {
        const msgFrame = buildStompFrame('MESSAGE', {
            destination: dest,
            'content-type': 'text/plain',
        }, message);
        subscriptions[dest].forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(msgFrame);
            }
        });
    }
}

wss.on('connection', (ws) => {
    ws.subscriptions = new Set();
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        let frame;
        try {
            frame = parseStompFrame(data);
        } catch (e) {
            ws.send(buildStompFrame('ERROR', {}, '프레임 파싱 오류'));
            return;
        }
        const { command, headers, body } = frame;
        if (command === 'CONNECT') {
            ws.send(buildStompFrame('CONNECTED', { version: '1.2' }));
        } else if (command === 'SUBSCRIBE') {
            const dest = headers.destination;
            if (!subscriptions[dest]) subscriptions[dest] = new Set();
            subscriptions[dest].add(ws);
            ws.subscriptions.add(dest);
        } else if (command === 'SEND') {
            const dest = headers.destination;
            console.log(`SEND 프레임 수신: destination=${dest}, body=${body}`);
            if (subscriptions[dest]) {
                const msgFrame = buildStompFrame('MESSAGE', {
                    destination: dest,
                    'content-type': 'text/plain',
                }, body);
                console.log(`MESSAGE 프레임 전송: ${subscriptions[dest].size}개 클라이언트에게`);
                subscriptions[dest].forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(msgFrame);
                    }
                });
            } else {
                console.log(`구독자가 없는 destination: ${dest}`);
            }
        } else if (command === 'DISCONNECT') {
            ws.close();
        }
    });

    ws.on('close', () => {
        // 구독 해제
        if (ws.subscriptions) {
            ws.subscriptions.forEach(dest => {
                if (subscriptions[dest]) {
                    subscriptions[dest].delete(ws);
                    if (subscriptions[dest].size === 0) delete subscriptions[dest];
                }
            });
        }
    });
});

// 관리자 페이지 라우트
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 관리자 메시지 전송 API
app.post('/admin/send', express.json(), (req, res) => {
    const { message } = req.body;
    if (message) {
        sendAdminMessage(message);
        res.json({ success: true, message: '메시지가 전송되었습니다.' });
    } else {
        res.status(400).json({ success: false, message: '메시지가 필요합니다.' });
    }
});

// 연결된 클라이언트 목록 API
app.get('/admin/clients', (req, res) => {
    const clientList = [];
    for (const dest in subscriptions) {
        clientList.push(`${dest} (${subscriptions[dest].size} 구독자)`);
    }
    res.json({ clients: clientList, count: clientList.length });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`STOMP 서버가 포트 ${PORT}에서 실행 중입니다.`);
}); 