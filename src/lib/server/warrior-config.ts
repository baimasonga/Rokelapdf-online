import { z } from 'zod';
const component = z.string().regex(/^opm_[a-f0-9]{24}$/);
const TOKEN = /^ops_v1\.opc_[a-f0-9]{32}\.[a-f0-9]{64}$/;
const KEYS = ['WARRIOR_EVENTS_TOKEN', 'WARRIOR_API_COMPONENT_ID', 'WARRIOR_CONVERTER_COMPONENT_ID', 'WARRIOR_SCANNER_COMPONENT_ID'] as const;
export interface WarriorConfig {
  token: string;
  apiComponentId: string;
  converterComponentId: string;
  scannerComponentId: string;
}
/**
 * Monitoring is optional, so a bad monitoring setting must never take the site down: it is logged (naming the
 * variables, never their values) and the app runs without monitoring. Values are trimmed, since pasted settings often
 * carry a stray space or newline.
 */
export function warriorConfig(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = (m) => console.error(JSON.stringify({ level: 'error', msg: m })),
): WarriorConfig | undefined {
  if (!KEYS.some((k) => env[k] !== undefined)) return;
  const values = KEYS.map((k) => env[k]?.trim() ?? '');
  const invalid = KEYS.filter((k, i) => (i === 0 ? !TOKEN.test(values[i]!) : !component.safeParse(values[i]).success));
  if (invalid.length) {
    warn(`Warrior monitoring disabled: missing or malformed ${invalid.join(', ')} (component ids are opm_ followed by 24 lowercase hex characters)`);
    return;
  }
  return { token: values[0]!, apiComponentId: values[1]!, converterComponentId: values[2]!, scannerComponentId: values[3]! };
}
