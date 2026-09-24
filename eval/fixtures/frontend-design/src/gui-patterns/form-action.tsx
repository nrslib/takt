import { useActionState } from 'react';

type ProfileState = {
  status: 'idle' | 'saved' | 'error';
  message: string;
};

const initialState: ProfileState = { status: 'idle', message: '' };

async function saveProfile(
  _previousState: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const name = formData.get('name');
  if (typeof name !== 'string' || name.trim() === '') {
    return { status: 'error', message: 'Name is required' };
  }
  return { status: 'saved', message: `Saved ${name}` };
}

export function Root() {
  const [state, formAction, isPending] = useActionState(saveProfile, initialState);
  return <ProfileScreen state={state} action={formAction} isPending={isPending} />;
}

function ProfileScreen({ state, action, isPending }: {
  state: ProfileState;
  action(formData: FormData): void;
  isPending: boolean;
}) {
  return <ProfileForm state={state} action={action} isPending={isPending} />;
}

function ProfileForm({ state, action, isPending }: {
  state: ProfileState;
  action(formData: FormData): void;
  isPending: boolean;
}) {
  return (
    <form action={action}>
      <label>
        Name
        <input name="name" />
      </label>
      <button type="submit" disabled={isPending}>Save</button>
      <output role="status">{state.message || state.status}</output>
    </form>
  );
}
