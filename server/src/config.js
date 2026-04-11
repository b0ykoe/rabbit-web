import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

export const config = {
  env:  process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,

  db: {
    host:     process.env.DB_HOST     || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT, 10) || 3306,
    database: process.env.DB_DATABASE || 'botauth',
    user:     process.env.DB_USERNAME || 'botauth',
    password: process.env.DB_PASSWORD || '',
  },

  sessionSecret: process.env.SESSION_SECRET || 'CHANGE_ME',

  bot: {
    ed25519PrivateKey: process.env.BOT_ED25519_PRIVATE_KEY || '',
    ed25519PublicKey:  process.env.BOT_ED25519_PUBLIC_KEY  || '',
    privateDir:       process.env.BOT_PRIVATE_DIR || './private/releases',
  },

  isProd: (process.env.NODE_ENV || 'development') === 'production',
};
