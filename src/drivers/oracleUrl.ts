// Oracle JDBC URLs (as copied from SQL Developer, DBeaver, Spring configs…) turned into what
// node-oracledb's thin mode understands: an Easy Connect string or a connect descriptor.
//
//   jdbc:oracle:thin:@host:1521:SID                 SID (sent as a descriptor)
//   jdbc:oracle:thin:@host:1521/service             service name (also @//host…, :dedicated, ?params)
//   jdbc:oracle:thin:@tcps://host:2484/service      TLS
//   jdbc:oracle:thin:@(DESCRIPTION=…)               descriptor, used as is
//   jdbc:oracle:thin:@alias?TNS_ADMIN=/folder       tnsnames.ora alias
//   jdbc:oracle:thin:user/password@…                credentials, moved to the form fields

export interface OracleUrl {
  kind: 'easy' | 'sid' | 'descriptor' | 'alias';
  host?: string;
  port?: number;
  /** Service name, with an optional `:dedicated`/`:shared`/`:pooled` suffix. */
  service?: string;
  sid?: string;
  /** Easy Connect parameters (`a=b&c=d`), without TNS_ADMIN. */
  params?: string;
  tcps: boolean;
  descriptor?: string;
  alias?: string;
  /** Folder holding tnsnames.ora (`TNS_ADMIN` parameter). */
  configDir?: string;
  user?: string;
  password?: string;
}

/** `connectBy` value of an Oracle connection that uses `jdbcUrl` instead of host/port/service. */
export const ORACLE_BY_URL = 'JDBC URL';

export function usesJdbcUrl(options: Record<string, unknown>): boolean {
  return options.connectBy === ORACLE_BY_URL;
}

const PREFIX = /^jdbc:oracle:(?:thin|oci8?|kprb):/i;
const ADDRESS = /^(\[[^\]]+\]|[^:/[\]]+)(?::(\d+))?(?::([^/:]+)|\/(.+))?$/;

export function parseJdbcUrl(input: string): OracleUrl {
  let rest = input.trim().replace(PREFIX, '');
  if (!rest) {
    throw new Error('The JDBC URL is empty.');
  }
  const result: OracleUrl = { kind: 'easy', tcps: false };
  if (rest.startsWith('@')) {
    rest = rest.slice(1);
  } else {
    // user/password@… — the credentials end at the last @ before any descriptor.
    const at = rest.indexOf('(') >= 0 ? rest.lastIndexOf('@', rest.indexOf('(')) : rest.lastIndexOf('@');
    if (at >= 0) {
      const credentials = rest.slice(0, at);
      rest = rest.slice(at + 1);
      const slash = credentials.indexOf('/');
      result.user = unquote(slash >= 0 ? credentials.slice(0, slash) : credentials) || undefined;
      result.password = slash >= 0 ? unquote(credentials.slice(slash + 1)) || undefined : undefined;
    }
  }
  if (rest.startsWith('(')) {
    result.kind = 'descriptor';
    result.descriptor = rest;
    result.tcps = /\(\s*PROTOCOL\s*=\s*TCPS\s*\)/i.test(rest);
    const host = /\(\s*HOST\s*=\s*([^)\s]+)\s*\)/i.exec(rest);
    const port = /\(\s*PORT\s*=\s*(\d+)\s*\)/i.exec(rest);
    result.host = host?.[1];
    result.port = port ? Number(port[1]) : undefined;
    return result;
  }
  rest = rest.replace(/^\/\//, '');
  const protocol = /^(tcps?):\/\//i.exec(rest);
  if (protocol) {
    result.tcps = protocol[1].toLowerCase() === 'tcps';
    rest = rest.slice(protocol[0].length);
  }
  const question = rest.indexOf('?');
  if (question >= 0) {
    const params = rest
      .slice(question + 1)
      .split('&')
      .filter((p) => {
        const [key, ...value] = p.split('=');
        if (key.trim().toUpperCase() === 'TNS_ADMIN') {
          result.configDir = decodeURIComponent(value.join('=').trim());
          return false;
        }
        return p.trim() !== '';
      });
    result.params = params.length ? params.join('&') : undefined;
    rest = rest.slice(0, question);
  }
  const m = ADDRESS.exec(rest);
  if (!m) {
    throw new Error(`Unrecognized Oracle JDBC URL: ${input.trim()}`);
  }
  const [, host, port, sid, service] = m;
  if (!port && !sid && !service && !protocol) {
    result.kind = 'alias';
    result.alias = host;
    return result;
  }
  result.host = host.replace(/^\[|\]$/g, '');
  result.port = port ? Number(port) : undefined;
  if (sid) {
    result.kind = 'sid';
    result.sid = sid;
  } else {
    result.service = service;
  }
  return result;
}

function unquote(text: string): string {
  return text.replace(/^"(.*)"$/, '$1');
}

/** The connect string for node-oracledb; `tls` forces TCPS when the form's SSL mode is on. */
export function connectString(url: OracleUrl, tls = false): string {
  const tcps = url.tcps || tls;
  switch (url.kind) {
    case 'descriptor':
      return url.descriptor!;
    case 'alias':
      return url.alias!;
    case 'sid':
      return `(DESCRIPTION=(ADDRESS=(PROTOCOL=${tcps ? 'TCPS' : 'TCP'})(HOST=${url.host})(PORT=${url.port ?? 1521}))(CONNECT_DATA=(SID=${url.sid})))`;
    default: {
      const host = url.host!.includes(':') ? `[${url.host}]` : url.host;
      const service = url.service ? `/${url.service}` : '';
      return `${tcps ? 'tcps://' : ''}${host}:${url.port ?? 1521}${service}${url.params ? `?${url.params}` : ''}`;
    }
  }
}

/** The same URL pointing at another address (an SSH tunnel's local port). */
export function withAddress(url: OracleUrl, host: string, port: number): OracleUrl {
  if (url.kind === 'alias') {
    throw new Error('An SSH tunnel needs the host in the JDBC URL; a TNS alias cannot go through it.');
  }
  if (url.kind === 'descriptor') {
    const descriptor = url.descriptor!.replace(/\(\s*HOST\s*=\s*[^)\s]+\s*\)/gi, `(HOST=${host})`).replace(/\(\s*PORT\s*=\s*\d+\s*\)/gi, `(PORT=${port})`);
    return { ...url, descriptor, host, port };
  }
  return { ...url, host, port };
}

/** The URL as text again, without credentials. */
export function formatJdbcUrl(url: OracleUrl): string {
  const tnsAdmin = url.configDir ? `TNS_ADMIN=${url.configDir}` : '';
  const query = [url.params, tnsAdmin].filter(Boolean).join('&');
  const suffix = query ? `?${query}` : '';
  switch (url.kind) {
    case 'descriptor':
      return `jdbc:oracle:thin:@${url.descriptor}`;
    case 'alias':
      return `jdbc:oracle:thin:@${url.alias}${suffix}`;
    case 'sid':
      return `jdbc:oracle:thin:@${url.tcps ? 'tcps://' : ''}${url.host}:${url.port ?? 1521}:${url.sid}`;
    default: {
      const host = url.host!.includes(':') ? `[${url.host}]` : url.host;
      const address = `${host}${url.port ? `:${url.port}` : ''}${url.service ? `/${url.service}` : ''}`;
      return `jdbc:oracle:thin:@${url.tcps ? 'tcps://' : '//'}${address}${suffix}`;
    }
  }
}
