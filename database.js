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

                  // Operator takeovers table
                  db.run(`
                    CREATE TABLE IF NOT EXISTS operator_takeovers (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      session_id TEXT NOT NULL,
                      booking_id INTEGER,
                      operator_id TEXT NOT NULL,
                      status TEXT NOT NULL,
                      reason TEXT,
                      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                      ended_at DATETIME,
                      FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL
                    )
                  `, (err) => {
                    if (err) {
                      console.error('Error creating operator_takeovers table:', err.message);
                      reject(err);
                      return;
                    }
                    console.log('Operator takeovers table created/verified');

                    // Audit events table (append-only)
                    db.run(`
                      CREATE TABLE IF NOT EXISTS audit_events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        event_type TEXT NOT NULL,
                        session_id TEXT,
                        operator_id TEXT,
                        takeover_id INTEGER,
                        idempotency_key TEXT,
                        payload TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (takeover_id) REFERENCES operator_takeovers(id) ON DELETE SET NULL
                      )
                    `, (err) => {
                      if (err) {
                        console.error('Error creating audit_events table:', err.message);
                        reject(err);
                        return;
                      }
                      console.log('Audit events table created/verified');

                      // Run migrations after all tables are created
                      runMigrations(db)
                        .then(() => {
                          // Seed default data after migrations
                          return seedDefaultData(db);
                        })
                        .then(() => {
                          console.log('Database initialization complete');
                          resolve(db);
                        })
                        .catch((err) => {
                          console.error('Error initializing database:', err.message);
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
    });
  });
}

/**
 * Run database migrations to add missing columns
 * @param {sqlite3.Database} db Database instance
 * @returns {Promise<void>}
 */
function runMigrations(db) {
  return new Promise((resolve, reject) => {
    // First, check the current schema
    db.all("PRAGMA table_info(bookings)", (err, rows) => {
      if (err) {
        console.error('Error checking bookings table structure:', err.message);
        resolve(); // Continue anyway
        return;
      }

      // Handle case where rows might be undefined or empty
      if (!rows || !Array.isArray(rows)) {
        rows = [];
      }

      const columnNames = rows.map(row => row.name);
      const hasTripId = columnNames.includes('trip_id');
      const hasRouteId = columnNames.includes('route_id');
      const hasHoldExpiresAt = columnNames.includes('hold_expires_at');
      const hasTicketAttachmentId = columnNames.includes('ticket_attachment_id');
      const hasTicketReceivedAt = columnNames.includes('ticket_received_at');

      db.serialize(() => {
        // Migration: Add trip_id column if it doesn't exist
        if (!hasTripId) {
          db.run(`
            ALTER TABLE bookings 
            ADD COLUMN trip_id INTEGER
          `, (err) => {
            if (err) {
              console.error('Error adding trip_id column:', err.message);
            } else {
              console.log('Added trip_id column to bookings table');
            }
          });
        }

        // Migration: Add hold_expires_at column to bookings if it doesn't exist
        if (!hasHoldExpiresAt) {
          db.run(`
            ALTER TABLE bookings 
            ADD COLUMN hold_expires_at DATETIME
          `, (err) => {
            if (err) {
              console.error('Error adding hold_expires_at column:', err.message);
            } else {
              console.log('Added hold_expires_at column to bookings table');
            }
          });
        }

        // Migration: Add ticket_attachment_id column to bookings if it doesn't exist
        if (!hasTicketAttachmentId) {
          db.run(`
            ALTER TABLE bookings 
            ADD COLUMN ticket_attachment_id TEXT
          `, (err) => {
            if (err) {
              console.error('Error adding ticket_attachment_id column:', err.message);
            } else {
              console.log('Added ticket_attachment_id column to bookings table');
            }
          });
        }

        // Migration: Add ticket_received_at column to bookings if it doesn't exist
        if (!hasTicketReceivedAt) {
          db.run(`
            ALTER TABLE bookings 
            ADD COLUMN ticket_received_at DATETIME
          `, (err) => {
            if (err) {
              console.error('Error adding ticket_received_at column:', err.message);
            } else {
              console.log('Added ticket_received_at column to bookings table');
            }
            resolve(); // Resolve after all migrations
          });
        } else {
          resolve(); // All columns already exist
        }
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
    // Normalize phone number function
    function normalizePhoneNumber(phoneNumber) {
      return phoneNumber.replace(/[\s+\-()]/g, '');
    }

    // Get and normalize operator phone
    const operatorPhone = process.env.OPERATOR_PHONE || '1234567890';
    const normalizedPhone = normalizePhoneNumber(operatorPhone);
    const operatorName = process.env.OPERATOR_NAME || 'Default Operator';

    // Check if default operator already exists (using normalized phone)
    db.get('SELECT id FROM operators WHERE phone_number = ?', [normalizedPhone], (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      if (row) {
        console.log(`Default operator already exists (ID: ${row.id}), skipping seed`);
        resolve();
        return;
      }

      // Insert default operator with normalized phone number
      db.run(
        'INSERT INTO operators (name, phone_number, approved) VALUES (?, ?, ?)',
        [operatorName, normalizedPhone, 1],
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
