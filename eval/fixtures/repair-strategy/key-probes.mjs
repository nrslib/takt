export const pairs = {
  A: [['a|b', 'c'], ['a', 'b|c']],
  B: [['a|b', 'c'], ['a~b', 'c']],
  C: [['a~b', 'c'], ['a_b', 'c']],
};
export function observe(service, probe) {
  const [left, right] = pairs[probe];
  return {
    left: service.key(left), right: service.key(right),
    leftAgain: service.key([...left]), rightAgain: service.key([...right]),
  };
}
export function satisfied(result) {
  return result.left !== result.right && result.left === result.leftAgain && result.right === result.rightAgain;
}
