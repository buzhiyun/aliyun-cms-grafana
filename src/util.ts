import type { ScopedVars } from '@grafana/data';
import { getTemplateSrv } from '@grafana/runtime';

/** True when obj is null/undefined/blank/"null"/'""' (legacy semantics preserved). */
export function isEmpty(obj: unknown): boolean {
  if (typeof obj === 'string') {
    return obj.trim().length === 0 || obj === 'null' || obj === '""';
  }
  return !obj;
}

/** True when the string contains a template variable reference. */
export function exists(name: string): boolean {
  return getTemplateSrv().containsTemplate(name);
}

/**
 * Resolves every template variable inside `target` and returns one string per
 * combination of variable values (cartesian product), e.g. for
 * "host=$host" with host=[a,b] the result is ["host=a","host=b"].
 */
export function resolve(target: string, scopedVars?: ScopedVars): string[] {
  const templateSrv = getTemplateSrv();
  const variables = templateSrv.getVariables() as Array<{ name: string }>;
  const variableNames = (variables || []).map((v) => '$' + v.name);

  let resolved = [target];
  if (variableNames.length > 0) {
    variableNames.forEach((name) => {
      if (target.indexOf(name) >= 0) {
        const values = getVarValues(name, scopedVars);
        const newResolved: string[] = [];
        const regex = new RegExp('\\' + name, 'g');
        values.forEach((val) => {
          resolved.forEach((t) => newResolved.push(t.replace(regex, val)));
        });
        resolved = newResolved;
      }
    });
  }
  return resolved;
}

/** Values of a single variable; unwraps the "{a,b,c}" multi-value format. */
export function getVarValues(name: string, scopedVars?: ScopedVars): string[] {
  const values = getTemplateSrv().replace(name, scopedVars);
  if (typeof values === 'string' && values.charAt(0) === '{') {
    return values.substring(1, values.length - 1).split(',');
  }
  return [values];
}

/** Resolves template variables in a string, returning the first value ('' when empty). */
export function templateToStr(tmpStr: string | undefined): string {
  if (isEmpty(tmpStr)) {
    return '';
  }
  let value = tmpStr as string;
  if (exists(value)) {
    const resolved = resolve(value);
    value = resolved.length > 0 ? resolved[0] : '';
  }
  return value;
}

/** Resolves a scalar query field, joining multi-value results like the legacy plugin did. */
export function resolveScalar(target: string | undefined, scopedVars?: ScopedVars): string {
  if (isEmpty(target)) {
    return '';
  }
  const value = target as string;
  if (!exists(value)) {
    return value;
  }
  return resolve(value, scopedVars).join(',');
}

/**
 * Splits a (possibly template-driven) string into an array.
 * Supports ";" and "," separated values and "[...]" wrapping.
 */
export function strToArray(strVar: string | undefined): string[] {
  let value = templateToStr(strVar);
  if (isEmpty(value)) {
    return [];
  }
  if (value.includes('[') || value.includes(']')) {
    value = value.replace('[', '').replace(']', '');
  }
  let parts: string[];
  if (value.includes(';')) {
    parts = value.split(';');
  } else if (value.includes(',')) {
    parts = value.split(',');
  } else {
    parts = [value];
  }
  return parts.map((p) => (exists(p) ? resolve(p)[0] : p));
}

/** Maps plain values to {text, value} option objects. */
export function arrayToMap(result: Array<string | number>): Array<{ text: string; value: string }> {
  return result.map((d) => ({ text: String(d), value: String(d) }));
}

export const wait = (ms: number) => new Promise<void>((resolve_) => setTimeout(resolve_, ms));
