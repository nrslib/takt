export function observe(service, probe) {
  if (probe === 'A') return service.cents(1.239);
  if (probe === 'B') return service.allowed({ id: 'reader', canRead: false });
  return service.name(' Ada ');
}
export function satisfied(result, probe) {
  return result === { A: 124, B: false, C: 'Ada' }[probe];
}
