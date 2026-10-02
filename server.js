const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Inicialización de la Base de Datos SQLite en archivo local
const db = new Database('asistencia.db');

// Creación de Tablas e Inserción de Datos Iniciales (Seed)
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    nombre TEXT,
    rol TEXT
  );

  CREATE TABLE IF NOT EXISTS empleados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT UNIQUE,
    nombre TEXT,
    departamento TEXT,
    puesto TEXT,
    estado TEXT DEFAULT 'Activo'
  );

  CREATE TABLE IF NOT EXISTS asistencias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empleado_id INTEGER,
    fecha TEXT,
    hora_entrada TEXT,
    hora_salida TEXT,
    estado TEXT,
    FOREIGN KEY(empleado_id) REFERENCES empleados(id)
  );
`);

// Poblar datos si la base está vacía
const userCount = db.prepare('SELECT count(*) AS count FROM usuarios').get();
if (userCount.count === 0) {
  db.prepare(`INSERT INTO usuarios (username, password, nombre, rol) VALUES ('admin', 'admin123', 'Administrador General', 'Admin')`).run();
  
  const insertEmp = db.prepare(`INSERT INTO empleados (codigo, nombre, departamento, puesto, estado) VALUES (?, ?, ?, ?, ?)`);
  insertEmp.run('EMP001', 'Ana Gómez', 'Sistemas', 'Desarrolladora Senior', 'Activo');
  insertEmp.run('EMP002', 'Carlos Ruíz', 'Recursos Humanos', 'Analista RRHH', 'Activo');
  insertEmp.run('EMP003', 'María López', 'Finanzas', 'Contadora', 'Activo');

  const insertAsis = db.prepare(`INSERT INTO asistencias (empleado_id, fecha, hora_entrada, hora_salida, estado) VALUES (?, ?, ?, ?, ?)`);
  const hoy = new Date().toISOString().split('T')[0];
  insertAsis.run(1, hoy, '08:00:15', '17:01:10', 'Puntual');
  insertAsis.run(2, hoy, '08:18:40', '17:00:00', 'Retardo');
  insertAsis.run(3, hoy, null, null, 'Falta');
}

// API RUTAS

// 1. Autenticación
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT id, username, nombre, rol FROM usuarios WHERE username = ? AND password = ?').get(username, password);
  if (user) {
    res.json({ success: true, user });
  } else {
    res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos' });
  }
});

// 2. Dashboard KPIs
app.get('/api/dashboard/stats', (req, res) => {
  const hoy = new Date().toISOString().split('T')[0];
  const totalEmpleados = db.prepare("SELECT count(*) as total FROM empleados WHERE estado = 'Activo'").get().total;
  const puntuales = db.prepare("SELECT count(*) as total FROM asistencias WHERE fecha = ? AND estado = 'Puntual'").get(hoy).total;
  const retardos = db.prepare("SELECT count(*) as total FROM asistencias WHERE fecha = ? AND estado = 'Retardo'").get(hoy).total;
  const faltas = db.prepare("SELECT count(*) as total FROM asistencias WHERE fecha = ? AND estado = 'Falta'").get(hoy).total;

  res.json({ totalEmpleados, puntuales, retardos, faltas });
});

// 3. Empleados (CRUD)
app.get('/api/employees', (req, res) => {
  const empleados = db.prepare('SELECT * FROM empleados ORDER BY id DESC').all();
  res.json(empleados);
});

app.post('/api/employees', (req, res) => {
  const { codigo, nombre, departamento, puesto, estado } = req.body;
  try {
    const stmt = db.prepare('INSERT INTO empleados (codigo, nombre, departamento, puesto, estado) VALUES (?, ?, ?, ?, ?)');
    const info = stmt.run(codigo, nombre, departamento, puesto, estado || 'Activo');
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ success: false, message: 'El código de empleado ya existe o datos inválidos' });
  }
});

app.put('/api/employees/:id', (req, res) => {
  const { codigo, nombre, departamento, puesto, estado } = req.body;
  const { id } = req.params;
  const stmt = db.prepare('UPDATE empleados SET codigo = ?, nombre = ?, departamento = ?, puesto = ?, estado = ? WHERE id = ?');
  stmt.run(codigo, nombre, departamento, puesto, estado, id);
  res.json({ success: true });
});

// 4. Asistencias (Consultas y Marcaje)
app.get('/api/attendance', (req, res) => {
  const query = `
    SELECT a.id, e.codigo, e.nombre, e.departamento, a.fecha, a.hora_entrada, a.hora_salida, a.estado 
    FROM asistencias a 
    JOIN empleados e ON a.empleado_id = e.id 
    ORDER BY a.fecha DESC, a.id DESC
  `;
  const registros = db.prepare(query).all();
  res.json(registros);
});

app.post('/api/attendance/mark', (req, res) => {
  const { codigo, tipo } = req.body; // tipo: 'entrada' o 'salida'
  const empleado = db.prepare('SELECT id FROM empleados WHERE codigo = ?').get(codigo);
  
  if (!empleado) {
    return res.status(404).json({ success: false, message: 'Código de empleado no encontrado' });
  }

  const hoy = new Date().toISOString().split('T')[0];
  const horaActual = new Date().toTimeString().split(' ')[0];

  const asistenciaExistente = db.prepare('SELECT * FROM asistencias WHERE empleado_id = ? AND fecha = ?').get(empleado.id, hoy);

  if (tipo === 'entrada') {
    const estado = horaActual > '08:15:00' ? 'Retardo' : 'Puntual';
    if (asistenciaExistente) {
      db.prepare('UPDATE asistencias SET hora_entrada = ?, estado = ? WHERE id = ?').run(horaActual, estado, asistenciaExistente.id);
    } else {
      db.prepare('INSERT INTO asistencias (empleado_id, fecha, hora_entrada, estado) VALUES (?, ?, ?, ?)').run(empleado.id, hoy, horaActual, estado);
    }
  } else {
    if (asistenciaExistente) {
      db.prepare('UPDATE asistencias SET hora_salida = ? WHERE id = ?').run(horaActual, asistenciaExistente.id);
    } else {
      db.prepare('INSERT INTO asistencias (empleado_id, fecha, hora_salida, estado) VALUES (?, ?, ?, ?)').run(empleado.id, hoy, horaActual, 'Incompleto');
    }
  }

  res.json({ success: true, message: `Marcaje de ${tipo} registrado correctamente (${horaActual})` });
});

// Arrancar Servidor
app.listen(PORT, () => {
  console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});
