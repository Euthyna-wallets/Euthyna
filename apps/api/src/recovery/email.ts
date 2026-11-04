/**
 * DKIM records for ZK Email seat recovery. The browser proves, with the Noir circuit in
 * circuits/email-recovery, that a DKIM key signed an email from some mailbox; it needs the
 * domain's key to build the proof, and browsers cannot query DNS. The recovery contract on
 * NEAR verifies the proof and accepts only the keys in its own registry (contracts/email-recovery).
 */
import { promises as dns } from "node:dns";

/** DKIM TXT records for selector._domainkey.domain, newest first; empty when none is found. */
export type DkimKeySource = (domain: string, selector: string) => Promise<string[]>;

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function dkimKeys(options: { testKeys?: Record<string, string> | undefined; fetcher?: typeof fetch } = {}): DkimKeySource {
  const fetcher = options.fetcher ?? fetch;
  return async (domain, selector) => {
    if (!NAME.test(domain) || !/^[a-z0-9._-]{1,63}$/i.test(selector)) return [];
    const test = options.testKeys?.[`${selector}._domainkey.${domain}`];
    if (test) return [test];
    const name = `${selector}._domainkey.${domain}`;
    const records: string[] = [];
    try {
      records.push(...(await dns.resolveTxt(name)).map((parts) => parts.join("")));
    } catch {
      try {
        const answer = await (await fetcher(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=TXT`, { signal: AbortSignal.timeout(8_000) })).json() as { Answer?: Array<{ data: string }> };
        records.push(...(answer.Answer ?? []).map((item) => item.data.replace(/"\s*"/g, "").replace(/^"|"$/g, "")));
      } catch { /* next source */ }
    }
    try {
      // Keys rotate: an email signed last month may use a key no longer in DNS.
      const archived = await (await fetcher(`https://archive.zk.email/api/key?domain=${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(8_000) })).json() as Array<{ selector: string; value: string }>;
      records.push(...archived.filter((item) => item.selector === selector).map((item) => item.value));
    } catch { /* DNS is enough when it answered */ }
    return records.filter((record) => /p=/.test(record));
  };
}
