import session from 'express-session';
import connectSessionKnex from 'connect-session-knex';
import { config } from '../config.js';
import db from '../db.js';

const KnexSessionStore = connectSessionKnex(session);

const store = new KnexSessionStore({
  knex: db,
  tablename: 'web_sessions',
  createtable: true,
  clearInterval: 60_000, // clear expired sessions every 60s
});

export const sessionMiddleware = session({
  store,
  name: 'bot_portal_sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   config.isProd,
    sameSite: 'strict',
    maxAge:   null, // session cookie by default; set to 30 days for "remember me"
  },
});
