/* Spins up a tiny RESP (Redis wire protocol) server and drives the real
 * _store.js TCP path against it. Proves REDIS_URL works without needing a
 * live Upstash database. */
import net from 'node:net';

const store = new Map();
let cmdCount = 0;

function parse(buf) {
  // *N\r\n$len\r\narg\r\n...
  const parts = buf.toString().split('\r\n');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith('$')) { out.push(parts[i + 1]); i++; }
  }
  return out;
}

const server = net.createServer((sock) => {
  sock.on('data', (buf) => {
    const raw = buf.toString();
    // a client may pipeline several commands in one packet
    for (const chunk of raw.split(/(?=\*\d)/).filter(Boolean)) {
      const args = parse(Buffer.from(chunk));
      if (!args.length) continue;
      const cmd = args[0].toUpperCase();
      cmdCount++;
      if (cmd === 'HELLO' || cmd === 'CLIENT' || cmd === 'AUTH' || cmd === 'INFO') {
        sock.write('+OK\r\n');
      } else if (cmd === 'SET') {
        store.set(args[1], args[2]);
        sock.write('+OK\r\n');
      } else if (cmd === 'GET') {
        const v = store.get(args[1]);
        sock.write(v === undefined ? '$-1\r\n' : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
      } else if (cmd === 'PING') {
        sock.write('+PONG\r\n');
      } else {
        sock.write('+OK\r\n');
      }
    }
  });
  sock.on('error', () => {});
});

await new Promise((r) => server.listen(6399, '127.0.0.1', r));

// exactly the name Vercel created for this project
process.env.CHAMPION_REDIS_URL = 'redis://127.0.0.1:6399';
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.BLOB_READ_WRITE_TOKEN;

const { readState, writeState, backend } = await import('./api/_store.js');

const pass = (n, c, x = '') => console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? '   ' + x : ''));

pass('CHAMPION_REDIS_URL selects the TCP backend', backend() === 'redis-tcp', backend());

const empty = await readState();
pass('empty store reads as null', empty === null);

const rec = { rev: 1, data: { tournaments: [{ name: 'FC World Cup' }], competitions: [] }, updatedAt: 'now' };
await writeState(rec);
const got = await readState();
pass('round-trips through the socket',
     got && got.rev === 1 && got.data.tournaments[0].name === 'FC World Cup',
     JSON.stringify(got && got.data.tournaments));

const before = cmdCount;
await readState(); await readState(); await readState();
pass('reuses the warm socket (no reconnect storm)', cmdCount - before === 3,
     `${cmdCount - before} commands for 3 reads`);

await writeState({ rev: 2, data: { tournaments: [], competitions: [] } });
pass('overwrites cleanly', (await readState()).rev === 2);

server.close();
process.exit(0);
