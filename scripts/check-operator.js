const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const DB_PATH = path.join(__dirname, '..', 'database.sqlite');

function normalizePhoneNumber(phoneNumber) {
  return phoneNumber.replace(/[\s+\-()]/g, '');
}

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
    process.exit(1);
  }

  const operatorPhone = process.env.OPERATOR_PHONE || '1234567890';
  const operatorName = process.env.OPERATOR_NAME || 'Default Operator';
  const normalizedPhone = normalizePhoneNumber(operatorPhone);

  console.log(`\n📱 Checking for operator with phone: ${normalizedPhone}`);
  console.log(`   Name: ${operatorName}\n`);

  db.get('SELECT * FROM operators WHERE phone_number = ?', [normalizedPhone], (err, row) => {
    if (err) {
      console.error('❌ Error querying database:', err.message);
      db.close();
      process.exit(1);
    }

    if (row) {
      console.log('✅ Operator found in database:');
      console.log(`   ID: ${row.id}`);
      console.log(`   Name: ${row.name}`);
      console.log(`   Phone: ${row.phone_number}`);
      console.log(`   Approved: ${row.approved === 1 ? 'Yes' : 'No'}`);
      console.log(`   Created: ${row.created_at}\n`);
      db.close();
      process.exit(0);
    } else {
      console.log('❌ Operator NOT found. Adding to database...\n');
      db.run(
        'INSERT INTO operators (name, phone_number, approved) VALUES (?, ?, ?)',
        [operatorName, normalizedPhone, 1],
        function (err) {
          if (err) {
            console.error('❌ Error adding operator:', err.message);
            db.close();
            process.exit(1);
          }
          console.log(`✅ Operator added successfully!`);
          console.log(`   ID: ${this.lastID}`);
          console.log(`   Name: ${operatorName}`);
          console.log(`   Phone: ${normalizedPhone}`);
          console.log(`   Approved: Yes\n`);
          db.close();
          process.exit(0);
        }
      );
    }
  });
});
