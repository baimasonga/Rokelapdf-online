import { z } from 'zod';
const component = z.string().regex(/^opm_[a-f0-9]{24}$/);
export interface WarriorConfig {
  token: string;
  apiComponentId: string;
  converterComponentId: string;
  scannerComponentId: string;
}
export function warriorConfig(env: Record<string, string | undefined>): WarriorConfig | undefined {
  const keys = ['WARRIOR_EVENTS_TOKEN', 'WARRIOR_API_COMPONENT_ID', 'WARRIOR_CONVERTER_COMPONENT_ID', 'WARRIOR_SCANNER_COMPONENT_ID'];
  if (!keys.some((k) => env[k] !== undefined)) return;
  const values = keys.map((k) => env[k]);
  if (!values.every(Boolean) || !/^ops_v1\.opc_[a-f0-9]{32}\.[a-f0-9]{64}$/.test(values[0]!))
    throw new Error('complete scoped Warrior configuration is required');
  for (const v of values.slice(1)) if (!component.safeParse(v).success) throw new Error('invalid Warrior component configuration');
  return { token: values[0]!, apiComponentId: values[1]!, converterComponentId: values[2]!, scannerComponentId: values[3]! };
}
