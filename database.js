const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'database.sqlite');

/**
 * Initialize SQLite database with schema and default data
 * @returns {Promise<sqlite3.Database>} Database instance
 */
function initializeDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('Error opening database:', err.message);
        reject(err);
        return;
      }
      console.log('Connected to SQLite database');
    });

    // Enable foreign keys
    db.run('PRAGMA foreign_keys = ON', (err) => {
      if (err) {
        console.error('Error enabling foreign keys:', err.message);
        reject(err);
        return;
      }
    });

    // Create tables
    db.serialize(() => {
      // Operators table
      db.run(`
        CREATE TABLE IF NOT EXISTS operators (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          phone_number TEXT NOT NULL UNIQUE,
          routes TEXT,
          approved INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) {
          console.error('Error creating operators table:', err.message);
          reject(err);
          return;
        }
        console.log('Operators table created/verified');

        // Routes table (base route definitions)
        db.run(`
          CREATE TABLE IF NOT EXISTS routes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operator_id INTEGER NOT NULL,
            source TEXT NOT NULL,
            destination TEXT NOT NULL,
            price REAL NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (operator_id) REFERENCES operators(id) ON DELETE CASCADE
          )
        `, (err) => {
          if (err) {
            console.error('Error creating routes table:', err.message);
            reject(err);
            return;
          }
          console.log('Routes table created/verified');

          // Trips table (route + date + time + seat quota)
          db.run(`
            CREATE TABLE IF NOT EXISTS trips (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              route_id INTEGER NOT NULL,
              journey_date DATE NOT NULL,
              departure_time TEXT NOT NULL,
              whatsapp_seat_quota INTEGER NOT NULL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
              UNIQUE(route_id, journey_date, departure_time)
            )
          `, (err) => {
            if (err) {
              console.error('Error creating trips table:', err.message);
              reject(err);
              return;
            }
            console.log('Trips table created/verified');

            // Bookings table (updated with trip_id and HOLD/EXPIRED status)
            db.run(`
              CREATE TABLE IF NOT EXISTS bookings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_name TEXT,
                customer_phone TEXT NOT NULL,
                trip_id INTEGER NOT NULL,
                seat_count INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'hold',
                hold_expires_at DATETIME,
                ticket_attachment_id TEXT,
                ticket_received_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
              )
            `, (err) => {
              if (err) {
                console.error('Error creating bookings table:', err.message);
                reject(err);
                return;
              }
              console.log('Bookings table created/verified');

              // Message logs table
              db.run(`
                CREATE TABLE IF NOT EXISTS message_logs (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  booking_id INTEGER,
                  type TEXT NOT NULL,
                  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
                )
              `, (err) => {
                if (err) {
                  console.error('Error creating message_logs table:', err.message);
                  reject(err);
                  return;
                }
                console.log('Message logs table created/verified');

                // Ticket attachments table (store WhatsApp media IDs)
                db.run(`
                  CREATE TABLE IF NOT EXISTS ticket_attachments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    booking_id INTEGER NOT NULL,
                    media_id TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    media_url TEXT,
                    received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
                  )
                `, (err) => {
                  if (err) {
                    console.error('Error creating ticket_attachments table:', err.message);
                    reject(err);
                    return;
                  }
                  console.log('Ticket attachments table created/verified');

                  // Seed default data after all tables are created
                  seedDefaultData(db)
                    .then(() => {
                      console.log('Database initialization complete');
                      resolve(db);
                    })
                    .catch((err) => {
                      console.error('Error seeding default data:', err.message);
                      reject(err);
                    });
                });
              });
            });
          });
        });
      });
    });
  });
}

/**
 * Seed default operator and route data
 * @param {sqlite3.Database} db Database instance
 * @returns {Promise<void>}
 */
function seedDefaultData(db) {
  return new Promise((resolve, reject) => {
    // Check if default operator already exists
    db.get('SELECT id FROM operators WHERE phone_number = ?', [process.env.OPERATOR_PHONE || '1234567890'], (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      if (row) {
        console.log('Default data already exists, skipping seed');
        resolve();
        return;
      }

      // Insert default operator
      const operatorPhone = process.env.OPERATOR_PHONE || '1234567890';
      const operatorName = process.env.OPERATOR_NAME || 'Default Operator';

      db.run(
        'INSERT INTO operators (name, phone_number, approved) VALUES (?, ?, ?)',
        [operatorName, operatorPhone, 1],
        function (err) {
          if (err) {
            reject(err);
            return;
          }

          const operatorId = this.lastID;
          console.log(`Default operator created with ID: ${operatorId}`);

          // Insert default route (without departure_time, now in trips)
          const defaultRoute = {
            source: 'City A',
            destination: 'City B',
            price: 500.00
          };

          db.run(
            'INSERT INTO routes (operator_id, source, destination, price) VALUES (?, ?, ?, ?)',
            [operatorId, defaultRoute.source, defaultRoute.destination, defaultRoute.price],
            function (err) {
              if (err) {
                reject(err);
                return;
              }

              const routeId = this.lastID;
              console.log(`Default route created with ID: ${routeId}`);
              console.log(`Route: ${defaultRoute.source} → ${defaultRoute.destination}, ₹${defaultRoute.price}`);

              // Create a default trip for tomorrow
              const tomorrow = new Date();
              tomorrow.setDate(tomorrow.getDate() + 1);
              const journeyDate = tomorrow.toISOString().split('T')[0];
              const departureTime = '08:00';
              const seatQuota = 5;

              db.run(
                'INSERT INTO trips (route_id, journey_date, departure_time, whatsapp_seat_quota) VALUES (?, ?, ?, ?)',
                [routeId, journeyDate, departureTime, seatQuota],
                function (err) {
                  if (err) {
                    reject(err);
                    return;
                  }

                  console.log(`Default trip created with ID: ${this.lastID}`);
                  console.log(`Trip: ${journeyDate} at ${departureTime}, WhatsApp quota: ${seatQuota} seats`);
                  resolve();
                }
              );
            }
          );
        }
      );
    });
  });
}

/**
 * Get database instance (singleton pattern)
 * @returns {Promise<sqlite3.Database>} Database instance
 */
let dbInstance = null;

async function getDatabase() {
  if (!dbInstance) {
    dbInstance = await initializeDatabase();
  }
  return dbInstance;
}

module.exports = {
  initializeDatabase,
  getDatabase,
  DB_PATH
};
