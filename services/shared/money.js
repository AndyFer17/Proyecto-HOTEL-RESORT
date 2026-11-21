export function parseMoney(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,9})\.\d{2}$/.test(value))
    throw new TypeError('Importe decimal inválido.');
  const [units, cents] = value.split('.');
  return BigInt(units) * 100n + BigInt(cents);
}

export function formatMoney(cents) {
  if (typeof cents !== 'bigint' || cents < 0n)
    throw new TypeError('Importe en centavos inválido.');
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}
