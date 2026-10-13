import assert from 'node:assert/strict';
import test from 'node:test';
import { registerMember } from '../src/signup.mjs';

test('normalizes an email address, stores the member, and sends confirmation', async () => {
  const members = new Map();
  const sent = [];
  const member = await registerMember('  Member@Example.test  ', members, async (email) => {
    sent.push(email);
  });
  assert.deepEqual(member, { email: 'member@example.test', status: 'pending' });
  assert.deepEqual(members.get('member@example.test'), member);
  assert.deepEqual(sent, ['member@example.test']);
});

test('rejects duplicate email addresses without adding a member or sending confirmation', async () => {
  const member = { email: 'member@example.test', status: 'pending' };
  const members = new Map([[member.email, member]]);
  const sent = [];
  await assert.rejects(registerMember('MEMBER@example.test', members, async (email) => {
    sent.push(email);
  }), /already registered/);
  assert.equal(members.size, 1);
  assert.equal(members.get(member.email), member);
  assert.deepEqual(sent, []);
});

test('propagates a confirmation email delivery failure', async () => {
  const members = new Map();
  const failure = new Error('Confirmation delivery failed');
  await assert.rejects(registerMember('member@example.test', members, async () => {
    throw failure;
  }), (error) => error === failure);
});
