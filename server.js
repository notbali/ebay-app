require('dotenv').config();
const express = require('express');
const path = require('path');
const partsRouter = require('./routes/parts');

const app = express();
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/parts', partsRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Listing assistant running at http://localhost:${PORT}`);
});
