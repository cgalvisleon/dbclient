# dbclient — Especificación y brecha

Fuente: `feature.md`. Este documento detalla los requisitos y mide la brecha entre lo implementado y el objetivo. **Se actualiza con cada cambio del proyecto** (estado de cada requisito, cálculo de la brecha e historial).

## 1. Objetivo

Extensión de VS Code (y editores compatibles como Cursor) llamada `dbclient`: un cliente de bases de datos al estilo de *Database Client* (`cweijan.vscode-database-client2`), con soporte para PostgreSQL, SQLite, MySQL, MSSQL, Oracle, Redis y NATS. La configuración de conexiones se guarda en un solo lugar, las bases SQL y Redis tienen editor con autocompletado, y NATS permite publicar y suscribirse.

## 2. Arquitectura

| Capa | Responsabilidad |
|---|---|
Estado: ✅ implementado · ⏳ pendiente.

| Capa | Responsabilidad | Estado |
|---|---|---|
| `src/extension.ts` | Activación, registro de comandos, vistas y proveedores. | ✅ |
| `src/store/connectionStore.ts` | `ConnectionStore`: lee y escribe `connections.json` en `context.globalStorageUri` (nivel usuario, compartido entre ventanas con `fs.watch`). Los secretos van en `context.secrets` con la clave `dbclient.<connectionId>.<campo>`. | ✅ (carpetas e import/export ⏳) |
| `src/drivers/` | `types.ts`: `Driver` (`connect`, `disconnect`, `children(node)`), `SqlDriver` (`execute`, `cancel`, `dialect`) y `DriverFactory` (campos del formulario, categoría, dialecto). `registry.ts`: registro por `type`. Sin dependencia de `vscode`. | ✅ (`KvDriver`/`PubSubDriver` ⏳) |
| `src/drivers/postgres.ts` | Pool por base para metadatos + una sesión dedicada por base para el editor (SET/BEGIN persisten), lectura con `pg-cursor` hasta `dbclient.maxRows`, cancelación con `pg_cancel_backend`, error con posición. | ✅ |
| `src/connections/manager.ts` | Instancias vivas de drivers por conexión; conectar, desconectar, probar. | ✅ |
| `src/tree/` | `TreeDataProvider` genérico que delega los hijos de cada nodo en el driver; conecta al expandir. | ✅ |
| `src/editor/` | `bindings.ts` (conexión de cada editor, barra de estado y botón en la barra del editor), `statements.ts` (división de sentencias con comillas, comentarios y `$$`), `sqlRunner.ts` (ejecutar, cancelar, diagnósticos), `codeLens.ts` (▶ Run por sentencia). | ✅ |
| `src/completion/` | Diccionarios ANSI + dialecto (hoy `postgres`) y `CompletionItemProvider` según la conexión del editor. | ✅ (objetos reales y alias ⏳) |
| `src/webviews/` + `media/` | Formulario de conexión generado desde `DriverFactory.fields`; panel inferior *Results* con pestañas por sentencia, paginación, orden, copiar, exportar y pestaña *Output* (salida SQL). | ✅ (visor Redis y panel NATS ⏳) |
| i18n | Las cadenas en tiempo de ejecución ya usan `vscode.l10n.t`; faltan `package.nls*.json` y `l10n/bundle.l10n.es.json`. | ⏳ |

Librerías (en uso: `pg`, `pg-cursor`; previstas el resto): `pg`, `mysql2`, `mssql` (tedious), `oracledb` (modo *thin*, sin cliente Oracle), `sql.js` o `@vscode/sqlite3` para SQLite (evitar módulos nativos que rompan el `.vsix` multiplataforma), `ioredis`, `nats`, `ssh2` para túneles. Build con `esbuild`, empaquetado con `@vscode/vsce`.

## 3. Requisitos

Estado: `0` pendiente · `0.5` parcial · `1` completo. Peso total = 107 (los pesos son puntos; la brecha se expresa en % del total, ver §4).

### F — Fundación (10)

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| F1 | Proyecto TypeScript de extensión (manifest `dbclient`, build esbuild, empaquetado `.vsix`, funciona en VS Code y Cursor) | 4 | 1 |
| F2 | Interfaz común de drivers y registro; agregar un motor no exige tocar árbol, editor ni grilla | 4 | 1 |
| F3 | Interfaz en español e inglés | 2 | 0 |

### C — Conexiones y persistencia (26)

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| C1 | Panel en la barra de actividad con árbol de conexiones (SQL: BD/esquema > tablas, vistas, funciones, procedimientos, índices; Redis: db > llaves por prefijo; NATS: streams/subjects y suscripciones) | 6 | 1 |
| C2 | Formulario de conexión: crear, editar, duplicar, eliminar, probar, conectar y desconectar | 6 | 1 |
| C3 | Persistencia centralizada a nivel usuario (`globalStorage`) con secretos en `SecretStorage` | 6 | 1 |
| C4 | Carpetas para agrupar conexiones | 2 | 0 |
| C5 | Exportar e importar la configuración (sin secretos) | 2 | 0 |
| C6 | SSL/TLS y túnel SSH | 4 | 0 |

### D — Drivers SQL (16)

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| D1 | PostgreSQL | 4 | 1 |
| D2 | SQLite | 3 | 0 |
| D3 | MySQL | 3 | 0 |
| D4 | MSSQL | 3 | 0 |
| D5 | Oracle | 3 | 0 |

### S — Editor SQL (33)

Referencia funcional: el editor SQL de NetBeans (selector de conexión en el editor, ejecutar archivo o sentencia con atajos, resultados en pestañas bajo el editor, paginación de filas traídas, salida SQL con tiempos y errores navegables, edición de datos en la grilla).

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| S1 | Archivo `.sql` asociado a una conexión con selector de conexión en la barra del editor; ejecutar archivo, selección o sentencia bajo el cursor con atajos; cancelar | 5 | 1 |
| S2 | Resultados en pestañas bajo el editor (una por sentencia, opción de conservar las anteriores); grilla con paginación de filas traídas (avance/retroceso), ordenar, copiar, exportar CSV/JSON | 6 | 1 |
| S3 | Autocompletado de palabras clave y funciones según el dialecto del driver | 4 | 1 |
| S4 | Autocompletado de objetos reales (esquemas, tablas, vistas, columnas) resolviendo alias | 5 | 0 |
| S5 | Historial de consultas por conexión | 2 | 0 |
| S6 | Acciones desde el árbol: estructura de tabla, abrir datos, DDL, generar SELECT/INSERT/UPDATE/DELETE | 4 | 0 |
| S7 | Salida SQL: registro por sentencia con tiempo de ejecución, filas afectadas y errores con línea/columna que navegan al editor | 3 | 1 |
| S8 | Edición de datos en la grilla: editar celdas, insertar y eliminar filas, confirmar o cancelar (genera el DML por clave primaria) | 4 | 0 |

### R — Redis (11)

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| R1 | Driver Redis y árbol de dbs/llaves por prefijo (con `SCAN`, sin `KEYS`) | 4 | 0 |
| R2 | Editor de comandos con autocompletado de comandos, argumentos y llaves existentes | 4 | 0 |
| R3 | Visor/editor de valores por tipo (string, hash, list, set, zset, stream) con TTL | 3 | 0 |

### N — NATS (11)

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| N1 | Conexión con usuario/clave, token, nkey o archivo de credenciales | 3 | 0 |
| N2 | Publicar (subject, payload, headers) y request/reply | 3 | 0 |
| N3 | Suscripción con comodines (`*`, `>`) y panel de mensajes en tiempo real | 3 | 0 |
| N4 | JetStream: listar streams y consumers | 2 | 0 |

## 4. Cálculo de la brecha

```
total   = Σ peso                      (hoy 107)
avance  = Σ (peso × estado)
brecha  = (total − avance) / total × 100 %
```

| Bloque | Peso | Avance | Brecha (pts) |
|---|---|---|---|
| F — Fundación | 10 | 8 | 2 |
| C — Conexiones y persistencia | 26 | 18 | 8 |
| D — Drivers SQL | 16 | 4 | 12 |
| S — Editor SQL | 33 | 18 | 15 |
| R — Redis | 11 | 0 | 11 |
| N — NATS | 11 | 0 | 11 |
| **Total** | **107** | **48** | **59** |

**Brecha actual: 55,1 % (59 de 107 pts)** — MVP completo (48 pts): una conexión PostgreSQL se crea, se guarda, se explora y se consulta desde un `.sql` con autocompletado, resultados en pestañas y salida SQL.

## 5. Orden sugerido para cerrar la brecha

1. ✅ **MVP (48 pts):** F1, F2, C1, C2, C3, D1, S1, S2, S3, S7. Una conexión PostgreSQL que se crea, se guarda y se consulta desde un `.sql` con autocompletado de palabras clave, resultados en pestañas y salida SQL.
2. **SQL completo (+29):** D2–D5, S4, S5, S6, S8, C4.
3. **Redis (+11):** R1–R3.
4. **NATS (+11):** N1–N4.
5. **Cierre (+8):** C5, C6, F3.

### Verificación del MVP

- `npm run typecheck` y `npm run build` sin errores; `npm run package` genera `dbclient-0.1.0.vsix` (51 KB).
- `npm test`: 13 pruebas unitarias (división de sentencias, `ConnectionStore`).
- Integración contra PostgreSQL 15 local (`DBCLIENT_PG_*`): 6 pruebas del driver (DML/consultas, tipos, truncado, estado de sesión, error con posición, cancelación, árbol).
- `npm run test:smoke`: VS Code real con la extensión; comandos registrados, store, árbol, autocompletado, CodeLens, ejecutar archivo con error ubicado en línea/columna, ejecutar sentencia bajo el cursor, desconectar.
- Sin verificar de forma automática: el aspecto visual de los webviews (formulario y panel de resultados) y el funcionamiento en Cursor.

## 6. Historial de la brecha

| Fecha | Cambio | Brecha |
|---|---|---|
| 2026-10-12 | Se complementa `feature.md` y se crea `spec.md`; sin implementación | 100 % |
| 2026-10-12 | Corrección ortográfica de `feature.md`; sin cambios de alcance ni de implementación | 100 % |
| 2026-10-12 | Referencia del editor SQL de NetBeans: S1 y S2 ampliados, nuevos S7 (salida SQL, 3) y S8 (edición en grilla, 4); total 100 → 107 pts, la brecha pasa a % del total; S7 entra al MVP | 100 % |
| 2026-10-12 | MVP implementado: F1, F2, C1, C2, C3, D1, S1, S2, S3, S7 (48 pts) | 55,1 % |
