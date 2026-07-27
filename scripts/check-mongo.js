#!/usr/bin/env node
/*
 * Standalone MongoDB connection diagnostic.
 *
 *   npm run check:mongo
 *
 * Works anywhere a MONGO_URI is available: run it on your laptop AND on the
 * server to find out whether a failure is environment-specific or the cluster
 * itself. It only reads MONGO_URI — it never touches app data.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI is not set. Put it in .env, or pass it inline:');
  console.error('  MONGO_URI="mongodb+srv://..." npm run check:mongo');
  process.exit(1);
}

const line = (char = '─') => console.log(char.repeat(66));
const ok = (msg) => console.log(`  [ok]   ${msg}`);
const bad = (msg) => console.log(`  [FAIL] ${msg}`);
const info = (msg) => console.log(`         ${msg}`);

/** Never prints the password, but does show everything else — the host matters. */
function describeUri(value) {
  try {
    const parsed = new URL(value);
    const raw = parsed.password || '';
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // Malformed escapes — leave it as-is.
    }
    return {
      scheme: parsed.protocol.replace(':', ''),
      host: parsed.hostname,
      user: parsed.username || '(none)',
      hasPassword: Boolean(raw),
      // Only a problem when the specials are present AND not escaped. If raw and
      // decoded differ, it is already percent-encoded and therefore fine.
      passwordNeedsEncoding: raw === decoded && /[@:/?#[\]]/.test(decoded),
      isSrv: parsed.protocol === 'mongodb+srv:',
    };
  } catch {
    return null;
  }
}

const isIpAddress = (value) => /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':');

async function main() {
  line('=');
  console.log(' MongoDB connection diagnostic');
  line('=');
  console.log(`\nNode ${process.version} | OpenSSL ${process.versions.openssl}`);
  console.log(`Default TLS range: ${tls.DEFAULT_MIN_VERSION} .. ${tls.DEFAULT_MAX_VERSION}`);

  console.log('\n[1] Connection string');
  const parts = describeUri(uri);
  if (!parts) {
    bad('MONGO_URI is not a parseable URI (must start with mongodb:// or mongodb+srv://).');
    process.exit(1);
  }
  ok(`scheme    ${parts.scheme}${parts.isSrv ? '   (SRV - DNS supplies the hosts)' : ''}`);
  ok(`host      ${parts.host}`);
  ok(`user      ${parts.user}`);
  if (!parts.hasPassword) {
    bad('No password in the URI.');
  } else if (parts.passwordNeedsEncoding) {
    bad('Password contains @ : / ? # [ ] which MUST be percent-encoded.');
    info('Unencoded, the URI parses wrongly and the host or auth is misread.');
  } else {
    ok('password  present, nothing needing encoding');
  }
  info('');
  info('>> Confirm that host is the cluster whose Network Access you configured.');
  info('   The IP Access List is PER PROJECT. Setting 0.0.0.0/0 on a different');
  info('   project than this cluster lives in is a common cause of rejection.');

  let hosts = [`${parts.host}:27017`];
  if (parts.isSrv) {
    console.log('\n[2] DNS (SRV lookup)');
    try {
      const records = await dns.resolveSrv(`_mongodb._tcp.${parts.host}`);
      hosts = records.map((r) => `${r.name}:${r.port}`);
      ok(`resolved ${records.length} shard host(s)`);
      hosts.forEach((h) => info(h));
    } catch (error) {
      bad(`SRV lookup failed: ${error.message}`);
      info('The cluster hostname is wrong, or DNS is blocked here.');
      process.exit(1);
    }
  }

  const [host, port] = hosts[0].split(':');

  console.log(`\n[3] Raw TCP to ${hosts[0]}`);
  const tcpOk = await new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port) });
    socket.setTimeout(8000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
  });
  if (tcpOk) ok('TCP connect succeeded - the port is reachable, nothing firewalled');
  else {
    bad('TCP connect failed - blocked before TLS even begins');
    info('Egress firewall, or the cluster does not exist / is fully stopped.');
  }

  const tryTls = (maxVersion) => new Promise((resolve) => {
    const socket = tls.connect(
      {
        host,
        port: Number(port),
        // Atlas requires SNI, but RFC 6066 forbids it for a bare IP.
        ...(isIpAddress(host) ? {} : { servername: host }),
        ...(maxVersion ? { maxVersion, minVersion: 'TLSv1.2' } : {}),
      },
      () => {
        const version = socket.getProtocol();
        socket.destroy();
        resolve({ ok: true, version });
      },
    );
    socket.setTimeout(8000);
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, error: 'timeout' }); });
    socket.on('error', (error) => resolve({ ok: false, error: error.message }));
  });

  console.log('\n[4] TLS handshake');
  const tlsDefault = await tryTls(null);
  if (tlsDefault.ok) ok(`default:        handshake OK (${tlsDefault.version})`);
  else bad(`default:        ${tlsDefault.error}`);

  const tls12 = await tryTls('TLSv1.2');
  if (tls12.ok) ok(`forced TLS 1.2: handshake OK (${tls12.version})`);
  else bad(`forced TLS 1.2: ${tls12.error}`);

  if (!tlsDefault.ok && tls12.ok) {
    console.log('\n  >> TLS 1.3 rejected but 1.2 accepted: a TLS version mismatch.');
    info('Fix: start the server with NODE_OPTIONS="--tls-max-v1.2"');
  }
  if (!tlsDefault.ok && !tls12.ok && tcpOk) {
    console.log('\n  >> Port open, but every TLS handshake refused. Atlas is actively');
    info('rejecting this connection. In order of likelihood:');
    info('  1. The cluster is PAUSED - resume it in the Atlas UI.');
    info('  2. The IP Access List is on a DIFFERENT Atlas project than this cluster.');
    info('  3. The cluster was deleted, or this hostname is stale.');
  }

  console.log('\n[5] Driver connect + ping');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
    const db = client.db(process.env.MONGO_DB || 'mailbox');
    await db.command({ ping: 1 });
    ok('connected, ping succeeded');
    const names = (await db.listCollections().toArray()).map((c) => c.name);
    ok(`database "${db.databaseName}": ${names.length ? names.join(', ') : '(no collections yet - normal before first use)'}`);
    line('=');
    console.log(' RESULT: MongoDB is reachable and usable from here.');
    line('=');
  } catch (error) {
    bad(String(error.message).split('\n')[0]);
    line('=');
    console.log(' RESULT: could not connect.\n');
    console.log(' If this ALSO fails on your laptop, the problem is the cluster or the');
    console.log(' URI, not your host. Check: cluster paused? correct Atlas project?');
    console.log(' correct cluster hostname? password percent-encoded?\n');
    console.log(' If it SUCCEEDS on your laptop but fails on the server, the problem is');
    console.log(' that environment - compare the two MONGO_URI values character by character.');
    line('=');
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error('\nDiagnostic itself crashed:', error);
  process.exit(1);
});
