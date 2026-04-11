cd D:\Personal\repositories\LastChaos\BotProject\portal-v2

# Install root deps
npm install

# Install server deps
cd server && npm install && cd ..

# Install client deps
cd client && npm install && cd ..

# Copy and configure .env
copy .env.example .env
# Edit .env with your DB credentials

# Run migrations + seed
npm run migrate
npm run seed

# Generate Ed25519 keypair
npm run keygen

# Start dev (runs both server + client)
npm run dev

admin@portal.local
Admin1234!
Abc123456789!