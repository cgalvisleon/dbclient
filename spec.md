# dbclient — Especificación y brecha

Fuente: `feature.md`. Este documento detalla los requisitos y mide la brecha entre lo implementado y el objetivo. **Se actualiza con cada cambio del proyecto** (estado de cada requisito, cálculo de la brecha e historial).

## 1. Objetivo

Extensión de VS Code (y editores compatibles como Cursor) llamada `dbclient`: un cliente de bases de datos al estilo de *Database Client* (`cweijan.vscode-database-client2`), con soporte para PostgreSQL, SQLite, MySQL, MSSQL, Oracle, Redis y NATS. La configuración de conexiones se guarda en un solo lugar, las bases SQL y Redis tienen editor con autocompletado, y NATS permite publicar y suscribirse.

## 2. Arquitectura propuesta

| Capa | Responsabilidad |
|---|---|
| `extension.ts` | Activación, registro de comandos, vistas y proveedores. |
| `store/` | `ConnectionStore`: lee y escribe `connections.json` en `context.globalStorageUri` (nivel usuario). Los secretos van en `context.secrets` con la clave `dbclient.<connectionId>.<campo>`. Carpetas, import/export sin secretos. |
| `drivers/` | Interfaz común `Driver` (`connect`, `disconnect`, `test`, `listChildren(node)`, `metadata()`) y sub-interfaces `SqlDriver` (`query`, `cancel`, `dialect`, `ddl`), `KvDriver` (Redis) y `PubSubDriver` (NATS). Un registro de drivers por `type`. |
| `tree/` | `TreeDataProvider` genérico que delega los hijos de cada nodo en el driver. |
| `editor/` | Archivos `.sql` y `.redis` asociados a una conexión (barra de estado para elegir conexión), CodeLens/comandos para ejecutar y `CompletionItemProvider` por lenguaje. |
| `completion/` | Diccionarios de palabras clave y funciones por dialecto, más una caché de metadatos (esquemas, tablas, columnas) por conexión; un parser ligero de `FROM`/`JOIN` para resolver alias. Comandos Redis con firma de argumentos. |
| `webviews/` | Formulario de conexión, grilla de resultados, visor de valores Redis y panel de mensajes NATS (webviews con mensajería `postMessage`). |
| `i18n` | `package.nls.json` / `package.nls.es.json` + `vscode.l10n` para cadenas en tiempo de ejecución. |

Librerías previstas: `pg`, `mysql2`, `mssql` (tedious), `oracledb` (modo *thin*, sin cliente Oracle), `sql.js` o `@vscode/sqlite3` para SQLite (evitar módulos nativos que rompan el `.vsix` multiplataforma), `ioredis`, `nats`, `ssh2` para túneles. Build con `esbuild`, empaquetado con `@vscode/vsce`.

## 3. Requisitos

Estado: `0` pendiente · `0.5` parcial · `1` completo. Peso total = 107 (los pesos son puntos; la brecha se expresa en % del total, ver §4).

### F — Fundación (10)

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| F1 | Proyecto TypeScript de extensión (manifest `dbclient`, build esbuild, empaquetado `.vsix`, funciona en VS Code y Cursor) | 4 | 0 |
| F2 | Interfaz común de drivers y registro; agregar un motor no exige tocar árbol, editor ni grilla | 4 | 0 |
| F3 | Interfaz en español e inglés | 2 | 0 |

### C — Conexiones y persistencia (26)

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| C1 | Panel en la barra de actividad con árbol de conexiones (SQL: BD/esquema > tablas, vistas, funciones, procedimientos, índices; Redis: db > llaves por prefijo; NATS: streams/subjects y suscripciones) | 6 | 0 |
| C2 | Formulario de conexión: crear, editar, duplicar, eliminar, probar, conectar y desconectar | 6 | 0 |
| C3 | Persistencia centralizada a nivel usuario (`globalStorage`) con secretos en `SecretStorage` | 6 | 0 |
| C4 | Carpetas para agrupar conexiones | 2 | 0 |
| C5 | Exportar e importar la configuración (sin secretos) | 2 | 0 |
| C6 | SSL/TLS y túnel SSH | 4 | 0 |

### D — Drivers SQL (16)

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| D1 | PostgreSQL | 4 | 0 |
| D2 | SQLite | 3 | 0 |
| D3 | MySQL | 3 | 0 |
| D4 | MSSQL | 3 | 0 |
| D5 | Oracle | 3 | 0 |

### S — Editor SQL (33)

Referencia funcional: el editor SQL de NetBeans (selector de conexión en el editor, ejecutar archivo o sentencia con atajos, resultados en pestañas bajo el editor, paginación de filas traídas, salida SQL con tiempos y errores navegables, edición de datos en la grilla).

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| S1 | Archivo `.sql` asociado a una conexión con selector de conexión en la barra del editor; ejecutar archivo, selección o sentencia bajo el cursor con atajos; cancelar | 5 | 0 |
| S2 | Resultados en pestañas bajo el editor (una por sentencia, opción de conservar las anteriores); grilla con paginación de filas traídas (avance/retroceso), ordenar, copiar, exportar CSV/JSON | 6 | 0 |
| S3 | Autocompletado de palabras clave y funciones según el dialecto del driver | 4 | 0 |
| S4 | Autocompletado de objetos reales (esquemas, tablas, vistas, columnas) resolviendo alias | 5 | 0 |
| S5 | Historial de consultas por conexión | 2 | 0 |
| S6 | Acciones desde el árbol: estructura de tabla, abrir datos, DDL, generar SELECT/INSERT/UPDATE/DELETE | 4 | 0 |
| S7 | Salida SQL: registro por sentencia con tiempo de ejecución, filas afectadas y errores con línea/columna que navegan al editor | 3 | 0 |
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
| F — Fundación | 10 | 0 | 10 |
| C — Conexiones y persistencia | 26 | 0 | 26 |
| D — Drivers SQL | 16 | 0 | 16 |
| S — Editor SQL | 33 | 0 | 33 |
| R — Redis | 11 | 0 | 11 |
| N — NATS | 11 | 0 | 11 |
| **Total** | **107** | **0** | **107** |

**Brecha actual: 100 % (107 de 107 pts)** — implementación del MVP en curso, aún sin requisitos cerrados.

## 5. Orden sugerido para cerrar la brecha

1. **MVP (48 pts):** F1, F2, C1, C2, C3, D1, S1, S2, S3, S7. Una conexión PostgreSQL que se crea, se guarda y se consulta desde un `.sql` con autocompletado de palabras clave, resultados en pestañas y salida SQL.
2. **SQL completo (+29):** D2–D5, S4, S5, S6, S8, C4.
3. **Redis (+11):** R1–R3.
4. **NATS (+11):** N1–N4.
5. **Cierre (+8):** C5, C6, F3.

## 6. Historial de la brecha

| Fecha | Cambio | Brecha |
|---|---|---|
| 2026-10-12 | Se complementa `feature.md` y se crea `spec.md`; sin implementación | 100 % |
| 2026-10-12 | Corrección ortográfica de `feature.md`; sin cambios de alcance ni de implementación | 100 % |
| 2026-10-12 | Referencia del editor SQL de NetBeans: S1 y S2 ampliados, nuevos S7 (salida SQL, 3) y S8 (edición en grilla, 4); total 100 → 107 pts, la brecha pasa a % del total; S7 entra al MVP | 100 % |
