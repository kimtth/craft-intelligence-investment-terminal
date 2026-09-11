// Shared Copilot/GUI declarative validation. Keep limits/formulas aligned with
// src/itt/criteria.py. This module is pure and safe to import in browser code.
export const CRITERIA_OPERANDS = Object.freeze(['open', 'high', 'low', 'close',
  ...['sma', 'ema'].flatMap(kind => [5, 10, 20, 50, 100, 200].map(period => `${kind}${period}`)),
  'rsi14', 'stoch9_6', 'stochrsi14', 'macd12_26', 'macd_signal9', 'adx14', 'plus_di14',
  'minus_di14', 'williams_r14', 'cci14', 'atr14', 'highs_lows14', 'ultimate7_14_28', 'roc12', 'bull13', 'bear13']);
export const CRITERIA_OPERATORS = Object.freeze(['gt', 'lt', 'gte', 'lte', 'eq', 'crosses_above', 'crosses_below']);
export const CRITERIA_LIMITS = Object.freeze({ depth: 12, nodes: 128, children: 32, cost: 4096 });
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const decimal = value => typeof value === 'string' && value.length <= 64
  && value === value.trim()
  && /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value)
  && Math.abs(Number(value.split(/[eE]/)[1] || 0)) <= 100;
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

/** Boolean validator; never coerces, executes or mutates a proposal. */
export function criterion(value) {
  let nodes = 0, cost = 0;
  const visit = (node, depth, weight, type) => {
    if (depth > CRITERIA_LIMITS.depth || ++nodes > CRITERIA_LIMITS.nodes) return false;
    cost += weight;
    if (cost > CRITERIA_LIMITS.cost) return false;
    if (type !== 'rule') {
      if (CRITERIA_OPERANDS.includes(node)) return true;
      if (type === 'operand' && (decimal(node)
          || (typeof node === 'number' && Number.isFinite(node) && decimal(String(node))))) return true;
      if (exact(node, ['field']) || exact(node, ['field', 'lag'])) {
        return ['open', 'high', 'low', 'close', 'volume'].includes(node.field)
          && (!Object.hasOwn(node, 'lag') || integer(node.lag, 0, 252));
      }
      if (exact(node, ['indicator', 'period']) || exact(node, ['indicator', 'period', 'lag'])) {
        if (!['sma', 'ema', 'rsi', 'roc', 'return', 'volatility'].includes(node.indicator)
            || !integer(node.period, 1, 252)
            || (Object.hasOwn(node, 'lag') && !integer(node.lag, 0, 252))) return false;
        cost += weight * (node.period - 1);
        return cost <= CRITERIA_LIMITS.cost;
      }
      return exact(node, ['operation', 'left', 'right'])
        && ['add', 'subtract', 'multiply', 'divide'].includes(node.operation)
        && visit(node.left, depth + 1, weight, 'operand') && visit(node.right, depth + 1, weight, 'operand');
    }
    if (exact(node, ['all']) || exact(node, ['any'])) {
      const children = node.all ?? node.any;
      if (!Array.isArray(children) || children.length < 1 || children.length > CRITERIA_LIMITS.children) return false;
      // Array.from rejects sparse arrays too. Depth bounds also reject cycles.
      return Array.from(children).every(child => visit(child, depth + 1, weight, 'rule'));
    }
    if (exact(node, ['not'])) return visit(node.not, depth + 1, weight, 'rule');
    if (!exact(node, ['left', 'op', 'right']) || !CRITERIA_OPERATORS.includes(node.op)) return false;
    const factor = node.op.startsWith('crosses_') ? 2 : 1;
    return visit(node.left, depth + 1, weight * factor, 'series')
      && visit(node.right, depth + 1, weight * factor, 'operand');
  };
  return visit(value, 1, 1, 'rule');
}