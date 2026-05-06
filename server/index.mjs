import { createApp } from './app.mjs';

const PORT = Number(process.env.PORT || 4175);
const app = createApp();

app.listen(PORT, () => {
  console.log(`DeckBridge API listening on http://localhost:${PORT}`);
});
