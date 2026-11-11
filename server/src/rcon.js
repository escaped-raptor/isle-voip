// Minimal client for The Isle: Evrima's RCON protocol.
// Evrima does NOT use Source RCON. Its protocol is:
//   auth:    0x01 + password + 0x00   -> reply contains "Password Accepted"
//   command: 0x02 + opcode + args + 0x00
import net from 'node:net';

export const OP = { playerList: 0x40, playerData: 0x77 };

/** Open a connection, run one command, return the text reply. */
export function rconCommand({ host, port, password }, opcode, arg = '', timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let stage = 'auth';
    let chunks = [];
    let idle = null;
    let settled = false;
    let deadline = null;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      clearTimeout(deadline);
      socket.destroy();
      err ? reject(err) : resolve(value);
    };
    deadline = setTimeout(() => {
      if (stage === 'command' && chunks.length) finish(null, Buffer.concat(chunks).toString('utf8'));
      else finish(new Error(stage === 'auth' ? 'RCON did not answer the login.' : 'RCON did not answer the command.'));
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(Buffer.concat([Buffer.from([0x01]), Buffer.from(password, 'utf8'), Buffer.from([0x00])]));
    });
    socket.on('data', (data) => {
      if (stage === 'auth') {
        if (!data.toString('utf8').includes('Password Accepted')) {
          return finish(new Error('RCON rejected the password.'));
        }
        stage = 'command';
        socket.write(Buffer.concat([Buffer.from([0x02, opcode]), Buffer.from(arg, 'utf8'), Buffer.from([0x00])]));
        return;
      }
      chunks.push(data);
      // Replies can span several packets; treat 400 ms of silence as the end.
      clearTimeout(idle);
      idle = setTimeout(() => finish(null, Buffer.concat(chunks).toString('utf8')), 400);
    });
    socket.on('error', (err) => finish(new Error(`RCON connection failed: ${err.message}`)));
    socket.on('close', () => {
      if (stage === 'command' && chunks.length) finish(null, Buffer.concat(chunks).toString('utf8'));
      else finish(new Error('RCON closed the connection.'));
    });
  });
}

/**
 * Parse a getplayerdata reply into [{ steamId, name, className, pos }].
 * pos is { x, y, z } in game units, or null if the record has no location.
 * The format is undocumented and has changed between game builds, so this is
 * deliberately tolerant: it looks for "Name:", a 17-digit ID and "Class:" in
 * each player record and ignores everything else.
 */
export function parsePlayerData(text) {
  const out = [];
  const records = String(text || '')
    .replace(/\0/g, '')
    .split(/(?=(?:PlayerData)?Name:\s)/);
  for (const rec of records) {
    const id = rec.match(/\b(?:PlayerID|SteamID|ID)\s*:\s*(\d{17})\b/i);
    const cls = rec.match(/\bClass\s*:\s*([A-Za-z0-9_]+)/);
    if (!id) continue;
    const name = rec.match(/Name:\s*([^,\n\r]*)/);
    const loc = rec.match(/Location\s*:\s*\(?\s*X\s*=\s*(-?[\d.]+)[\s,]*Y\s*=\s*(-?[\d.]+)[\s,]*Z\s*=\s*(-?[\d.]+)/i);
    const pos = loc ? { x: Number(loc[1]), y: Number(loc[2]), z: Number(loc[3]) } : null;
    out.push({ steamId: id[1], name: name ? name[1].trim() : '', className: cls ? cls[1] : '', pos });
  }
  return out;
}
