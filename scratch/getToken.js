require('dotenv').config();
const jwt = require('jsonwebtoken');
const token = jwt.sign({ userId: 'test-user-id', role: 'owner' }, process.env.JWT_SECRET || 'testsecret', { expiresIn: '1d' });
console.log(token);
