import bcrypt from 'bcryptjs';

/** @param {import('knex').Knex} knex */
export async function seed(knex) {
  // Only create if no admin exists (safe to re-run)
  const existing = await knex('users').where('role', 'admin').first();
  if (existing) {
    console.log('Admin user already exists — skipping seed.');
    return;
  }

  const hash = await bcrypt.hash('Admin1234!', 12);
  await knex('users').insert({
    name:                  'Admin',
    email:                 'admin@portal.local',
    password:              hash,
    role:                  'admin',
    force_password_change: true,
  });

  console.log('Default admin created: admin@portal.local / Admin1234!');
  console.log('Password change is required on first login.');
}
