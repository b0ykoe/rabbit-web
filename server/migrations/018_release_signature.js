/**
 * W-8 — detached Ed25519 signature over the raw release bytes.
 *
 * On upload we sign the file with BOT_ED25519_PRIVATE_KEY; the 64-byte
 * signature is base64-encoded (88 chars) and stored in `dll_signature`.
 * The download endpoint returns it in an X-Release-Signature response
 * header so the bot can verify integrity before executing the payload —
 * closing the "MITM swaps the DLL" window left open by AES-only delivery.
 *
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  const hasSig = await knex.schema.hasColumn('releases', 'dll_signature');
  if (!hasSig) {
    await knex.schema.alterTable('releases', (t) => {
      t.string('dll_signature', 128).nullable();
    });
  }
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  if (await knex.schema.hasColumn('releases', 'dll_signature')) {
    await knex.schema.alterTable('releases', (t) => t.dropColumn('dll_signature'));
  }
}
