export async function registerMember(email, members, sendConfirmation) {
  const normalizedEmail = email.trim().toLowerCase();
  if (members.has(normalizedEmail)) throw new Error('Email address is already registered');
  const member = { email: normalizedEmail, status: 'pending' };
  members.set(normalizedEmail, member);
  await sendConfirmation(normalizedEmail);
  return member;
}
