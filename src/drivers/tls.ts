import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import type { ConnectionOptions } from 'tls';
import { ConnectionConfig, ConnectionSecrets, FieldSpec } from './types';

// SSL/TLS settings shared by the network drivers: the form fields and the Node TLS options
// built from them. `require` encrypts without checking the certificate; `verify-full` checks
// the chain (against the CA file when given) and the host name.

export const SSL_SECTION = 'SSL / TLS';
const ON = ['require', 'verify-full'];

export function sslFields(clientCertificate = true): FieldSpec[] {
  const when = { field: 'ssl', values: ON };
  return [
    {
      key: 'ssl',
      label: 'SSL',
      kind: 'select',
      default: 'disable',
      choices: ['disable', 'require', 'verify-full'],
      section: SSL_SECTION,
      hint: 'require: encrypted, certificate not checked · verify-full: certificate and host name checked.',
    },
    { key: 'sslCa', label: 'CA certificate', kind: 'file', showWhen: when, section: SSL_SECTION, placeholder: 'PEM file (optional: system CAs otherwise)' },
    ...(clientCertificate
      ? ([
          { key: 'sslCert', label: 'Client certificate', kind: 'file', showWhen: when, section: SSL_SECTION, placeholder: 'PEM file (optional)' },
          { key: 'sslKey', label: 'Client key', kind: 'file', showWhen: when, section: SSL_SECTION, placeholder: 'PEM file (optional)' },
          { key: 'sslPassphrase', label: 'Key passphrase', kind: 'password', secret: true, showWhen: when, section: SSL_SECTION },
        ] as FieldSpec[])
      : []),
  ];
}

export function expandHome(file: string): string {
  return file.replace(/^~(?=$|[\\/])/, os.homedir());
}

function readPem(options: ConnectionConfig['options'], key: string, what: string): Buffer | undefined {
  const file = options[key];
  if (!file) {
    return undefined;
  }
  const full = expandHome(String(file));
  try {
    return fs.readFileSync(full);
  } catch (err) {
    throw new Error(`SSL: cannot read the ${what} ${full}: ${(err as Error).message}`);
  }
}

/** Node TLS options for the connection, or undefined when SSL is off. */
export function tlsOptions(options: ConnectionConfig['options'], secrets: ConnectionSecrets, host?: string): ConnectionOptions | undefined {
  const mode = String(options.ssl ?? 'disable');
  if (!ON.includes(mode)) {
    return undefined;
  }
  // Through an SSH tunnel the socket goes to 127.0.0.1; the certificate is still checked against the real host.
  const name = String(options.tlsServername ?? host ?? '');
  return {
    rejectUnauthorized: mode === 'verify-full',
    ca: readPem(options, 'sslCa', 'CA certificate'),
    cert: readPem(options, 'sslCert', 'client certificate'),
    key: readPem(options, 'sslKey', 'client key'),
    passphrase: secrets.sslPassphrase || undefined,
    servername: name && !net.isIP(name) ? name : undefined,
  };
}
