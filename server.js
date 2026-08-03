require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const api        = require('./routes/api');
const asana      = require('./routes/asana');
const tapclicks  = require('./routes/tapclicks');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', api);
app.use('/api/asana', asana);
app.use('/api/tapclicks', tapclicks);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`REV77 Health Score running on port ${PORT}`);
});
