import * as util from '../util';

jest.mock('@grafana/runtime', () => ({
  getTemplateSrv: () => ({
    getVariables: () => [{ name: 'host' }, { name: 'env' }],
    replace: (target: string) => {
      if (target.includes('$host')) {
        return target.replace(/\$host/g, '{h1,h2}');
      }
      if (target.includes('$env')) {
        return target.replace(/\$env/g, 'prod');
      }
      return target;
    },
    containsTemplate: (t: string) => /\$(host|env)\b/.test(t),
  }),
}));

describe('isEmpty', () => {
  it.each([undefined, null, '', ' ', '  ', 'null', '""'])('treats %p as empty', (value) => {
    expect(util.isEmpty(value)).toBe(true);
  });

  it.each(['a', '0', 'false', '{}'])('treats %p as non-empty', (value) => {
    expect(util.isEmpty(value)).toBe(false);
  });
});

describe('resolve', () => {
  it('expands multi-value variables into one string per value', () => {
    expect(util.resolve('host=$host')).toEqual(['host=h1', 'host=h2']);
  });

  it('returns the target unchanged when it contains no variables', () => {
    expect(util.resolve('host=static')).toEqual(['host=static']);
  });

  it('expands single-value variables', () => {
    expect(util.resolve('env=$env')).toEqual(['env=prod']);
  });

  it('expands combinations of variables', () => {
    expect(util.resolve('$env-$host')).toEqual(['prod-h1', 'prod-h2']);
  });
});

describe('resolveScalar', () => {
  it('joins multi-value results with commas (legacy behaviour)', () => {
    expect(util.resolveScalar('$host')).toBe('h1,h2');
  });

  it('returns plain values as-is', () => {
    expect(util.resolveScalar('acs_ecs_dashboard')).toBe('acs_ecs_dashboard');
  });

  it('returns an empty string for empty input', () => {
    expect(util.resolveScalar(undefined)).toBe('');
    expect(util.resolveScalar('')).toBe('');
  });
});

describe('strToArray', () => {
  it('splits on semicolons', () => {
    expect(util.strToArray('a;b;c')).toEqual(['a', 'b', 'c']);
  });

  it('splits on commas', () => {
    expect(util.strToArray('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('unwraps [] and resolves variables in each part (multi-value takes first, legacy behaviour)', () => {
    expect(util.strToArray('[$env,$host]')).toEqual(['prod', 'h1']);
  });

  it('returns a single element array for plain values', () => {
    expect(util.strToArray('solo')).toEqual(['solo']);
  });

  it('returns an empty array for empty input', () => {
    expect(util.strToArray(undefined)).toEqual([]);
  });
});

describe('templateToStr', () => {
  it('resolves variables to their first value', () => {
    expect(util.templateToStr('$host')).toBe('h1');
  });

  it('returns empty string for empty input', () => {
    expect(util.templateToStr(undefined)).toBe('');
  });
});

describe('arrayToMap', () => {
  it('maps values to text/value pairs', () => {
    expect(util.arrayToMap(['a', 1])).toEqual([
      { text: 'a', value: 'a' },
      { text: '1', value: '1' },
    ]);
  });
});
