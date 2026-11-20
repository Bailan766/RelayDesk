export function normalizeIpCidr(input: string): string {
  const [host, prefix, extra] = input.trim().split('/');
  const ipv6 = host.includes(':');
  const bits = ipv6 ? 128 : 32;
  if (extra !== undefined || (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) > bits))) {
    throw new Error('请输入有效的 IP 地址或 CIDR 网段');
  }
  if (ipv6 && /^[\da-f:.]+$/i.test(host)) {
    try {
      const address = new URL(`http://[${host}]/`).hostname.slice(1, -1);
      return `${address}/${prefix === undefined ? bits : Number(prefix)}`;
    } catch { throw new Error('IPv6 地址格式无效'); }
  }
  const octets = host.split('.');
  if (octets.length !== 4 || octets.some(part => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
    throw new Error('请输入有效的 IP 地址或 CIDR 网段');
  }
  return `${host}/${prefix === undefined ? bits : Number(prefix)}`;
}
