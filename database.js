const sqlite3 = require('sqlite3').verbose();
const { RetryableError } = require('./services/errors');
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
                seat_numbers TEXT,
                status TEXT NOT NULL DEFAULT 'hold',
                hold_expires_at DATETIME,
                lock_key TEXT,
                lock_keys TEXT,
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

                    // Audit events table (append-only, idempotency source of truth)
                    db.run(`
                      CREATE TABLE IF NOT EXISTS audit_events (
                        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                        source TEXT,
                        event_type TEXT NOT NULL,
                        idempotency_key TEXT,
                        entity_type TEXT,
                        entity_id TEXT,
                        status TEXT,
                        request_hash TEXT,
                        response_snapshot TEXT,
                        error_snapshot TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        completed_at DATETIME,
                        session_id TEXT,
                        operator_id TEXT,
                        takeover_id INTEGER,
                        payload TEXT,
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
function migrateAuditEventsSchema(db) {
  return new Promise((resolve, reject) => {
    db.all("PRAGMA table_info(audit_events)", (err, rows) => {
      if (err) {
        console.error('Error checking audit_events table structure:', err.message);
        resolve();
        return;
      }
      const columns = Array.isArray(rows) ? rows : [];
      const columnMap = new Map(columns.map(col => [col.name, col]));
      const requiredColumns = [
        'id',
        'source',
        'event_type',
        'idempotency_key',
        'entity_type',
        'entity_id',
        'status',
        'request_hash',
        'response_snapshot',
        'error_snapshot',
        'created_at',
        'completed_at'
      ];
      const missingRequired = requiredColumns.filter(name => !columnMap.has(name));
      const idColumn = columnMap.get('id');
      const idType = (idColumn?.type || '').toUpperCase();
      const needsRebuild = missingRequired.length > 0 || (idColumn && !idType.includes('TEXT'));

      const createAuditEventsTable = () => new Promise((resolveCreate, rejectCreate) => {
        db.run(
          `CREATE TABLE IF NOT EXISTS audit_events (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            source TEXT,
            event_type TEXT NOT NULL,
            idempotency_key TEXT,
            entity_type TEXT,
            entity_id TEXT,
            status TEXT,
            request_hash TEXT,
            response_snapshot TEXT,
            error_snapshot TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            session_id TEXT,
            operator_id TEXT,
            takeover_id INTEGER,
            payload TEXT,
            FOREIGN KEY (takeover_id) REFERENCES operator_takeovers(id) ON DELETE SET NULL
          )`,
          (createErr) => {
            if (createErr) {
              rejectCreate(createErr);
              return;
            }
            db.run(
              `CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_events_idempotency
               ON audit_events (source, event_type, idempotency_key)`,
              (indexErr) => {
                if (indexErr) {
                  rejectCreate(indexErr);
                  return;
                }
                resolveCreate();
              }
            );
          }
        );
      });

      if (needsRebuild) {
        db.serialize(() => {
          db.run('ALTER TABLE audit_events RENAME TO audit_events_legacy', (renameErr) => {
            if (renameErr) {
              reject(renameErr);
              return;
            }
            createAuditEventsTable()
              .then(() => {
                db.run(
                  `INSERT INTO audit_events (
                    id,
                    source,
                    event_type,
                    idempotency_key,
                    entity_type,
                    entity_id,
                    status,
                    request_hash,
                    response_snapshot,
                    error_snapshot,
                    created_at,
                    completed_at,
                    session_id,
                    operator_id,
                    takeover_id,
                    payload
                  )
                  SELECT
                    lower(hex(randomblob(16))),
                    NULL,
                    event_type,
                    idempotency_key,
                    NULL,
                    NULL,
                    'completed',
                    NULL,
                    payload,
                    NULL,
                    created_at,
                    created_at,
                    session_id,
                    operator_id,
                    takeover_id,
                    payload
                  FROM audit_events_legacy`,
                  (copyErr) => {
                    if (copyErr) {
                      reject(copyErr);
                      return;
                    }
                    db.run('DROP TABLE audit_events_legacy', (dropErr) => {
                      if (dropErr) {
                        reject(dropErr);
                        return;
                      }
                      resolve();
                    });
                  }
                );
              })
              .catch(reject);
          });
        });
        return;
      }

      const addColumn = (columnSql) => new Promise((resolveAdd) => {
        db.run(columnSql, () => resolveAdd());
      });

      db.serialize(() => {
        const additions = [];
        if (!columnMap.has('source')) {
          additions.push(addColumn(`ALTER TABLE audit_events ADD COLUMN source TEXT`));
        }
        if (!columnMap.has('idempotency_key')) {
          additions.push(addColumn(`ALTER TABLE audit_events ADD COLUMN idempotency_key TEXT`));
        }
        if (!columnMap.has('entity_type')) {
          additions.push(addColumn(`ALTER TABLE audit_events ADD COLUMN entity_type TEXT`));
        }
        if (!columnMap.has('entity_id')) {
          additions.push(addColumn(`ALTER TABLE audit_events ADD COLUMN entity_id TEXT`));
        }
        if (!columnMap.has('status')) {
          additions.push(addColumn(`ALTER TABLE audit_events ADD COLUMN status TEXT`));
        }
        if (!columnMap.has('request_hash')) {
          additions.push(addColumn(`ALTER TABLE audit_events ADD COLUMN request_hash TEXT`));
        }
        if (!columnMap.has('response_snapshot')) {
          additions.push(addColumn(`ALTER TABLE audit_events ADD COLUMN response_snapshot TEXT`));
        }
        if (!columnMap.has('error_snapshot')) {
          additions.push(addColumn(`ALTER TABLE audit_events ADD COLUMN error_snapshot TEXT`));
        }
        if (!columnMap.has('completed_at')) {
          additions.push(addColumn(`ALTER TABLE audit_events ADD COLUMN completed_at DATETIME`));
        }

        Promise.all(additions)
          .then(createAuditEventsTable)
          .then(resolve)
          .catch(reject);
      });
    });
  });
}

function migrateCancellationSchema(db) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(
        `CREATE TABLE IF NOT EXISTS cancellations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          booking_id INTEGER NOT NULL UNIQUE,
          cancelled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          cancelled_by TEXT NOT NULL,
          cancellation_reason TEXT,
          actor_id TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
        )`,
        (err) => {
          if (err) {
            reject(err);
            return;
          }
          db.run(
            `CREATE INDEX IF NOT EXISTS idx_cancellations_booking
             ON cancellations (booking_id)`,
            (indexErr) => {
              if (indexErr) {
                reject(indexErr);
                return;
              }
              resolve();
            }
          );
        }
      );
    });
  });
}

function migrateInventoryOverridesSchema(db) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(
        `CREATE TABLE IF NOT EXISTS inventory_overrides (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          route_id INTEGER NOT NULL,
          trip_date DATE NOT NULL,
          seat_number INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'blocked',
          reason TEXT,
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME,
          unblocked_at DATETIME,
          unblocked_by TEXT,
          FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
          UNIQUE(route_id, trip_date, seat_number)
        )`,
        (err) => {
          if (err) {
            reject(err);
            return;
          }
          db.run(
            `CREATE INDEX IF NOT EXISTS idx_inventory_overrides_route_date
             ON inventory_overrides (route_id, trip_date, status)`,
            (indexErr) => {
              if (indexErr) {
                reject(indexErr);
                return;
              }
              resolve();
            }
          );
        }
      );
    });
  });
}

function runMigrations(db) {
  return new Promise((resolve, reject) => {
    migrateAuditEventsSchema(db)
      .then(() => migrateCancellationSchema(db))
      .then(() => migrateInventoryOverridesSchema(db))
      .then(() => {
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
          const hasLockKey = columnNames.includes('lock_key');
          const hasLockKeys = columnNames.includes('lock_keys');
          const hasSeatNumbers = columnNames.includes('seat_numbers');
          const hasCancelledAt = columnNames.includes('cancelled_at');
          const hasCancelledBy = columnNames.includes('cancelled_by');
          const hasCancellationReason = columnNames.includes('cancellation_reason');

          const finalize = () => {
            db.serialize(() => {
              db.run(
                `UPDATE bookings
                 SET status = 'hold'
                 WHERE LOWER(status) IN ('pending', 'payment_pending')`
              );
              db.run(
                `UPDATE bookings
                 SET status = 'cancelled'
                 WHERE LOWER(status) IN ('rejected')`,
                (normalizeErr) => {
                  if (normalizeErr) {
                    console.error('Error normalizing booking statuses:', normalizeErr.message);
                  }
                  resolve();
                }
              );
            });
          };

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
                finalize();
              });
            } else {
              finalize();
            }

            if (!hasLockKey) {
              db.run(`
                ALTER TABLE bookings 
                ADD COLUMN lock_key TEXT
              `, (err) => {
                if (err) {
                  console.error('Error adding lock_key column:', err.message);
                } else {
                  console.log('Added lock_key column to bookings table');
                }
              });
            }

            if (!hasLockKeys) {
              db.run(`
                ALTER TABLE bookings 
                ADD COLUMN lock_keys TEXT
              `, (err) => {
                if (err) {
                  console.error('Error adding lock_keys column:', err.message);
                } else {
                  console.log('Added lock_keys column to bookings table');
                }
              });
            }

            if (!hasSeatNumbers) {
              db.run(`
                ALTER TABLE bookings 
                ADD COLUMN seat_numbers TEXT
              `, (err) => {
                if (err) {
                  console.error('Error adding seat_numbers column:', err.message);
                } else {
                  console.log('Added seat_numbers column to bookings table');
                }
              });
            }

            if (!hasCancelledAt) {
              db.run(`
                ALTER TABLE bookings
                ADD COLUMN cancelled_at DATETIME
              `, (err) => {
                if (err) {
                  console.error('Error adding cancelled_at column:', err.message);
                } else {
                  console.log('Added cancelled_at column to bookings table');
                }
              });
            }

            if (!hasCancelledBy) {
              db.run(`
                ALTER TABLE bookings
                ADD COLUMN cancelled_by TEXT
              `, (err) => {
                if (err) {
                  console.error('Error adding cancelled_by column:', err.message);
                } else {
                  console.log('Added cancelled_by column to bookings table');
                }
              });
            }

            if (!hasCancellationReason) {
              db.run(`
                ALTER TABLE bookings
                ADD COLUMN cancellation_reason TEXT
              `, (err) => {
                if (err) {
                  console.error('Error adding cancellation_reason column:', err.message);
                } else {
                  console.log('Added cancellation_reason column to bookings table');
                }
              });
            }
          });
        });
      })
      .catch((migrationError) => {
        console.error('Error running migrations:', migrationError.message);
        resolve();
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
  if (process.env.DB_FORCE_UNAVAILABLE === '1') {
    throw new RetryableError('Database unavailable', {
      code: 'DB_UNAVAILABLE'
    });
  }
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
