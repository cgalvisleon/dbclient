# dbclient — Especificación y brecha

Fuente: `feature.md`. Este documento detalla los requisitos y mide la brecha entre lo implementado y el objetivo. **Se actualiza con cada cambio del proyecto** (estado de cada requisito, cálculo de la brecha e historial).

## 1. Objetivo

Extensión de VS Code (y editores compatibles como Cursor) llamada `dbclient`: un cliente de bases de datos al estilo de *Database Client* (`cweijan.vscode-database-client2`), con soporte para PostgreSQL, SQLite, MySQL, MSSQL, Oracle, Redis y NATS. La configuración de conexiones se guarda en un solo lugar, las bases SQL y Redis tienen editor con autocompletado, y NATS permite publicar y suscribirse.

## 2. Arquitectura

Estado: ✅ implementado · ⏳ pendiente.

| Capa | Responsabilidad | Estado |
|---|---|---|
| `src/extension.ts` | Activación, registro de comandos, vistas y proveedores. | ✅ |
| `src/store/connectionStore.ts` | `ConnectionStore`: lee y escribe `connections.json` en `context.globalStorageUri` (nivel usuario, compartido entre ventanas con `fs.watch`) con conexiones y carpetas anidadas. Los secretos van en `context.secrets` con la clave `dbclient.<connectionId>.<campo>`. | ✅ |
| `src/drivers/types.ts` + `registry.ts` | `Driver` (`connect`, `disconnect`, `children(node)`, `onDidChange`), `SqlDriver` (`execute` → varios resultados por lote, `cancel`, `dialect`, `catalog`, `describe`, `ddl`, `transaction` parametrizada que exige las filas esperadas), `KvDriver` (`command`, `scan`), `PubSubDriver` (`publish`, `request`, `subscribe`, `unsubscribe`) y `DriverFactory` (campos del formulario con `secret`/`showWhen`/`file`, categoría, dialecto). Sin dependencia de `vscode`. | ✅ |
| `src/drivers/postgres.ts` | `pg` + `pg-cursor`: pool por base para metadatos, sesión dedicada por base (SET/BEGIN persisten), truncado en `dbclient.maxRows`, cancelación con `pg_cancel_backend`, error con posición. | ✅ |
| `src/drivers/mysql.ts` | `mysql2`: bases > carpetas (tablas, vistas, funciones, procedimientos, triggers, índices) > columnas; sesión por base; truncado con `KILL QUERY` (esperado antes de liberar la sesión); error con línea. | ✅ |
| `src/drivers/mssql.ts` | `mssql`/tedious: bases > esquemas > carpetas; sesión de una conexión por base usando lotes (`batch`, así #temp y SET persisten); varios result sets por lote; cancelación; error con línea. | ✅ |
| `src/drivers/oracle.ts` | `oracledb` modo *thin* (sin cliente Oracle): esquemas > carpetas (incluye paquetes y secuencias); sesión por esquema (`CURRENT_SCHEMA`); auto-commit configurable; bloques PL/SQL; cancelación con `break()`; error con posición. | ✅ |
| `src/drivers/sqlite.ts` | `node:sqlite` integrado en Node ≥ 22.13 (Cursor, VS Code ≥ 1.101): sin módulos nativos; síncrono, sin cancelación. | ✅ |
| `src/drivers/redis.ts` | `ioredis`: dbs con número de llaves > llaves agrupadas por separador (SCAN, nunca KEYS, tope 5000 por nivel) con su tipo; un cliente por db. | ✅ |
| `src/drivers/nats.ts` | `nats`: autenticación ninguna/usuario/token/nkey/credenciales; publicar con headers, request/reply, suscripciones con comodines y cola; árbol con suscripciones activas, streams y consumers de JetStream. | ✅ |
| `src/drivers/tls.ts` + `src/drivers/sshTunnel.ts` | Campos y opciones SSL/TLS comunes (CA, certificado y clave del cliente, frase) y túnel SSH con `ssh2` (contraseña o clave, huella del host): el driver se conecta a `127.0.0.1:<puerto local>` y el certificado se sigue verificando contra el host real. | ✅ |
| `l10n/` + `package.nls*.json` + `media/l10n.js` | Traducciones al español del código (`vscode.l10n`), del manifiesto y de los webviews (la extensión inyecta el diccionario del idioma activo). | ◐ (falta verla en el editor) |
| `src/connections/manager.ts` | Instancias vivas de drivers; conectar, desconectar, probar; cambios del driver refrescan solo su rama del árbol. | ✅ |
| `src/tree/` | `TreeDataProvider` genérico: SQL, Redis y NATS en el mismo listado, agrupados en carpetas (arrastrar y soltar, mover, renombrar, eliminar); iconos de `img/`. | ✅ |
| `src/editor/` | `bindings.ts` (conexión de cada editor `.sql`/`.redis`, barra de estado), `statements.ts` (división por dialecto: `GO`, `DELIMITER`, `/` y bloques PL/SQL, triggers), `sqlRunner.ts`, `gridEditor.ts` (edición en la grilla), `tableActions.ts` (acciones de tablas), `historyPicker.ts`, `redisRunner.ts` (una orden por línea, confirma FLUSHDB/FLUSHALL), `codeLens.ts`. | ✅ |
| `src/completion/` | Diccionarios ANSI + PostgreSQL, MySQL, SQL Server, Oracle y SQLite; con la conexión abierta, esquemas, tablas, vistas y columnas reales (`connections/catalog.ts`, caché por conexión) resolviendo alias; catálogo de ~110 comandos Redis con opciones y sugerencia de llaves existentes. | ✅ |
| `src/sql/` | Puro: `parse.ts` (tokens, tablas con alias, SELECT de una tabla, contexto de autocompletado), `identifiers.ts` (comillas y marcadores por dialecto), `generate.ts` (plantillas, estructura, CREATE TABLE, DML de la grilla), `editable.ts` (columnas editables del resultado). | ✅ |
| `src/webviews/` + `media/` | Formulario de conexión; panel *Results* (pestañas, paginación, orden, copiar, exportar CSV/JSON/Excel, edición de celdas y filas con confirmar/cancelar, *Output*); visor/editor de valores Redis; consola NATS. | ✅ |
| `src/store/sqlFiles.ts` | Archivos `.sql` guardados por conexión en `<raíz>/<connectionId>/`; crear en cualquier carpeta; `FolderWatcher` para carpetas vinculadas. | ✅ |
| `src/store/sqlLocations.ts` + `src/connections/sqlLocations.ts` | Ubicaciones por conexión (interna, vinculadas, de guardado), expansión de `~`/`${workspaceFolder}`, dueño de un archivo por la ruta más específica, listado con límites. | ✅ |
| `src/export/xlsx.ts` | Escritor `.xlsx` sin dependencias (ZIP + SpreadsheetML): encabezado en negrita y congelado, filtro, números y fechas tipados sin perder precisión. | ✅ |
| `scripts/build-icons.mjs` | Recorta los iconos de `img/` (quita la etiqueta y el halo oscuro) y genera `media/icons/` (variantes clara y oscura) y `media/icon.png`. | ✅ |
| i18n | Las cadenas en tiempo de ejecución ya usan `vscode.l10n.t`; faltan `package.nls*.json` y `l10n/bundle.l10n.es.json`. | ⏳ |

Librerías: `pg`, `pg-cursor`, `mysql2`, `mssql`, `oracledb`, `ioredis`, `nats` (todas JavaScript puro) y `node:sqlite`. Previstas: `ssh2` para túneles. Build con `esbuild`, empaquetado con `@vscode/vsce`.

## 3. Requisitos

Estado: `0` pendiente · `0.5` parcial · `1` completo. Peso total = 115 (los pesos son puntos; la brecha se expresa en % del total, ver §4).

### F — Fundación (10)

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| F1 | Proyecto TypeScript de extensión (manifest `dbclient`, build esbuild, empaquetado `.vsix`, funciona en VS Code y Cursor) | 4 | 1 |
| F2 | Interfaz común de drivers y registro; agregar un motor no exige tocar árbol, editor ni grilla | 4 | 1 |
| F3 | Interfaz en español e inglés: textos de la extensión (`vscode.l10n`), manifiesto (`package.nls`), webviews y campos de los formularios; el idioma sigue al de VS Code/Cursor | 2 | 0.5 |

### C — Conexiones y persistencia (26)

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| C1 | Panel en la barra de actividad con árbol de conexiones (SQL: BD/esquema > tablas, vistas, funciones, procedimientos, índices; Redis: db > llaves por prefijo; NATS: streams/subjects y suscripciones) | 6 | 1 |
| C2 | Formulario de conexión: crear, editar, duplicar, eliminar, probar, conectar y desconectar | 6 | 1 |
| C3 | Persistencia centralizada a nivel usuario (`globalStorage`) con secretos en `SecretStorage` | 6 | 1 |
| C4 | Carpetas para agrupar conexiones | 2 | 1 |
| C5 | Exportar e importar la configuración (sin secretos): todo o una carpeta; importar fusionando (conserva lo existente, omite lo idéntico, copia renombrada si hay conflicto) o reemplazando (con confirmación); los ids se conservan para que una copia restaurada recupere sus claves y archivos SQL | 2 | 1 |
| C6 | SSL/TLS (desactivado / requerido / verificar todo; CA, certificado y clave del cliente con frase) y túnel SSH (contraseña o clave privada con frase, huella de la llave del host) en todos los motores de red | 4 | 1 |

### D — Drivers SQL (16)

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| D1 | PostgreSQL | 4 | 1 |
| D2 | SQLite | 3 | 1 |
| D3 | MySQL | 3 | 1 |
| D4 | MSSQL | 3 | 1 |
| D5 | Oracle | 3 | 1 |

### S — Editor SQL (41)

Referencia funcional: el editor SQL de NetBeans (selector de conexión en el editor, ejecutar archivo o sentencia con atajos, resultados en pestañas bajo el editor, paginación de filas traídas, salida SQL con tiempos y errores navegables, edición de datos en la grilla).

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| S1 | Archivo `.sql` asociado a una conexión con selector de conexión en la barra del editor; ejecutar archivo, selección o sentencia bajo el cursor con atajos; cancelar | 5 | 1 |
| S2 | Resultados en pestañas bajo el editor (una por sentencia, opción de conservar las anteriores); grilla con paginación de filas traídas (avance/retroceso), ordenar, copiar, exportar CSV/JSON | 6 | 1 |
| S3 | Autocompletado de palabras clave y funciones según el dialecto del driver | 4 | 1 |
| S4 | Autocompletado de objetos reales (esquemas, tablas, vistas, columnas) resolviendo alias | 5 | 1 |
| S5 | Historial de consultas por conexión (SQL y Redis): sentencia, base, duración, filas o error; búsqueda, insertar en el editor o abrir en uno nuevo, copiar, limpiar; tamaño configurable (`dbclient.historySize`, 0 lo apaga) y sin comandos con credenciales | 2 | 1 |
| S6 | Acciones desde el árbol: estructura de tabla, abrir datos, DDL, generar SELECT/INSERT/UPDATE/DELETE | 4 | 1 |
| S7 | Salida SQL: registro por sentencia con tiempo de ejecución, filas afectadas y errores con línea/columna que navegan al editor | 3 | 1 |
| S8 | Edición de datos en la grilla: editar celdas, insertar y eliminar filas, confirmar o cancelar (genera el DML por clave primaria) | 4 | 1 |
| S9 | Carpeta SQL por conexión: archivos `.sql` persistentes, vinculados a su conexión al abrirlos; crear, renombrar, eliminar, guardar la consulta actual; ubicación configurable | 3 | 1 |
| S10 | Exportar resultados a Excel (`.xlsx`) con números y fechas como valores de Excel | 2 | 1 |
| S11 | Ubicaciones SQL por conexión: vincular carpetas existentes con archivos `.sql` (subcarpetas, `~` y `${workspaceFolder}`), vínculo automático por la carpeta más específica (empate: se pregunta y se recuerda), ubicación de guardado configurable, vigilancia de cambios externos; desvincular nunca borra archivos | 3 | 1 |

### R — Redis (11)

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| R1 | Driver Redis y árbol de dbs/llaves por prefijo (con `SCAN`, sin `KEYS`) | 4 | 1 |
| R2 | Editor de comandos con autocompletado de comandos, argumentos y llaves existentes | 4 | 1 |
| R3 | Visor/editor de valores por tipo (string, hash, list, set, zset, stream) con TTL | 3 | 1 |

### N — NATS (11)

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| N1 | Conexión con usuario/clave, token, nkey o archivo de credenciales | 3 | 1 |
| N2 | Publicar (subject, payload, headers) y request/reply | 3 | 1 |
| N3 | Suscripción con comodines (`*`, `>`) y panel de mensajes en tiempo real | 3 | 1 |
| N4 | JetStream: listar streams y consumers | 2 | 1 |

## 4. Cálculo de la brecha

```
total   = Σ peso                      (hoy 115)
avance  = Σ (peso × estado)
brecha  = (total − avance) / total × 100 %
```

| Bloque | Peso | Avance | Brecha (pts) |
|---|---|---|---|
| F — Fundación | 10 | 9 | 1 |
| C — Conexiones y persistencia | 26 | 26 | 0 |
| D — Drivers SQL | 16 | 16 | 0 |
| S — Editor SQL | 41 | 41 | 0 |
| R — Redis | 11 | 11 | 0 |
| N — NATS | 11 | 11 | 0 |
| **Total** | **115** | **114** | **1** |

**Brecha actual: 0,9 % (1 de 115 pts)** — los 7 motores funcionan en el mismo listado de conexiones, agrupables en carpetas; el editor SQL está completo al estilo NetBeans: archivos y ubicaciones `.sql`, historial, acciones sobre tablas desde el árbol, autocompletado de esquemas, tablas y columnas con alias, y edición de datos en la grilla; los resultados se exportan a Excel y NATS está verificado con todas sus autenticaciones; la configuración se exporta e importa sin secretos; las conexiones de red usan SSL/TLS y túnel SSH, y la interfaz está traducida al español. Falta: ver la interfaz en español dentro de VS Code/Cursor (F3 parcial: el VS Code de pruebas no tomó el idioma por argumento).

## 5. Orden sugerido para cerrar la brecha

1. ✅ **MVP (48 pts):** F1, F2, C1, C2, C3, D1, S1, S2, S3, S7. Una conexión PostgreSQL que se crea, se guarda y se consulta desde un `.sql` con autocompletado de palabras clave, resultados en pestañas y salida SQL.
2. ✅ **SQL completo (+29):** D2–D5 (12), C4 (2), S4–S8 (15).
3. ✅ **Redis (+11):** R1–R3.
4. ✅ **NATS (+11):** N1–N4.
5. ◐ **Cierre (+8):** ✅ C5 (2), ✅ C6 (4), ◐ F3 (1 de 2: falta verla en el editor).

### Verificación (v0.9.0)

- `npm run test:integration` (archivos en serie: en paralelo, con todos los entornos de prueba arriba, Oracle y SQL Server superan los tiempos de espera en esta máquina): 149 pruebas, 2 omitidas; `npm run test:smoke` completo con los 7 motores, SSL y SSH; `npm run package` genera `dbclient-0.9.0.vsix` sin módulos nativos.
- SSL/TLS (C6): `scripts/tls-fixture.sh` crea una CA y certificados de servidor y cliente y levanta PostgreSQL, MySQL, Redis y NATS con TLS y un proxy TLS (`socat`) delante del Oracle local. 6 pruebas de integración: PostgreSQL (sin SSL rechazado, `require`, `verify-full` con CA, CA desconocida rechazada, archivo inexistente, usuario con certificado de cliente, clave cifrada con frase correcta e incorrecta), MySQL (transporte seguro y `REQUIRE X509`), Redis y NATS (certificado de cliente obligatorio), Oracle TCPS en modo *thin* contra el proxy (el Oracle en sí no se configuró con TCPS) y SQL Server cifrado con y sin verificar su certificado autofirmado. Prueba de humo: PostgreSQL `verify-full` con certificado de cliente desde el store y el árbol.
- Túnel SSH (C6): `scripts/ssh-fixture.sh` levanta un `sshd` temporal. 4 pruebas de integración: PostgreSQL con contraseña, Redis con clave, NATS con clave cifrada, MySQL con huella del host; rechazos por contraseña, frase o huella incorrectas y archivo inexistente; el puerto local se cierra con el túnel. Prueba de humo: PostgreSQL y Redis por túnel y TLS dentro del túnel, con `ssh2` empaquetado (sin sus módulos nativos opcionales). 6 pruebas unitarias (destino y reescritura del túnel, opciones TLS, campos en todos los motores de red, secciones del formulario en jsdom). Corregido: un campo recién visible del formulario perdía su valor por defecto (el puerto SSH aparecía vacío).
- Idiomas (F3): 286 textos en `l10n/bundle.l10n.es.json` y 52 del manifiesto en `package.nls.es.json`; prueba unitaria que extrae todas las claves (`l10n.t` del código, `t()` de los webviews, campos de los drivers y palabras del árbol) y exige traducción completa, sin claves sobrantes y con los mismos marcadores `{n}`; prueba del inyector de traducciones de los webviews. Sin verificar: la interfaz en español dentro de VS Code/Cursor (el VS Code de pruebas siguió en inglés con `--locale es`, incluso con el paquete de idioma instalado).

### Verificación (v0.8.0)

- `npm test`: 126 pruebas (6 omitidas sin los servidores de autenticación NATS); `npm run test:smoke` completo con los 7 motores; `npm run package` genera `dbclient-0.8.0.vsix`.
- Exportar e importar (C5): 5 pruebas unitarias (sin secretos aunque una entrada vieja los tenga en `options`, exportar una carpeta con sus subcarpetas, restaurar con los mismos ids y recuperar la clave, carpetas reutilizadas, conflictos de id y de nombre como copias renombradas, motores desconocidos ignorados, reemplazar borra lo que no está en el archivo y sus secretos, archivos inválidos) y prueba de humo en VS Code con los comandos (todo y una carpeta, restaurar, importar dos veces sin duplicar, reemplazar). No verificado a mano: los diálogos de archivo, el selector Merge/Replace y la confirmación de Replace.

### Verificación (v0.7.0)

- `npm test`: 121 pruebas (6 omitidas sin los servidores de autenticación NATS); `npm run test:smoke` completo con los 7 motores; `npm run package` genera `dbclient-0.7.0.vsix`.
- Contrato nuevo de `SqlDriver` (`catalog`, `describe`, `ddl`, `transaction`) en los 5 motores: 20 pruebas de integración (catálogo de tablas y vistas, columnas, clave primaria compuesta e índices, nombre sin esquema y en minúsculas, DDL de tabla con su índice y de vista, transacción con actualización e inserción, fechas que vuelven intactas, reversión completa cuando una clave no existe).
- Acciones del árbol (S6): prueba de humo por motor: nodo de tabla con su nombre real, plantillas SELECT/INSERT/UPDATE/DELETE, DDL en un editor vinculado y las dos pestañas de estructura (columnas e índices).
- Autocompletado (S4): pruebas unitarias del lector SQL (tablas con alias en FROM con comas, JOIN, UPDATE, INSERT, subconsultas; contexto tabla/columna/miembro) y prueba de humo por motor: columnas tras `alias.` y tablas tras `FROM`.
- Edición en la grilla (S8): pruebas unitarias del mapeo (`*` por nombre, listas por posición, expresiones y duplicados de solo lectura, motivos: vista, sin clave primaria, clave ausente) y del DML parametrizado por dialecto; prueba de humo por motor: **Open Data** editable, confirmar actualización + inserción + eliminación y recarga de las filas guardadas, rechazo con reversión de una clave vieja, motivo de solo lectura; prueba del webview real (`media/results.js`) en jsdom: doble clic, Enter/Escape/Tab, columnas de solo lectura, NULL, fila nueva con DEFAULT, eliminar, confirmar y su respuesta, error que conserva los cambios, cancelar y texto que sobrevive a un redibujado. No verificado a mano: el aspecto visual de la grilla editable en VS Code/Cursor.

### Verificación (v0.6.0)

- `npm test`: 91 pruebas (2 omitidas); `npm run test:smoke` completo con los 7 motores; `npm run package` genera `dbclient-0.6.0.vsix`.
- NATS autenticación (N1): `scripts/nats-auth-fixture.sh` levanta servidores NATS temporales (usuario/clave + nkey, token y modo operador con `.creds` generados por `nsc`, todo aleatorio). 4 pruebas de integración: conectar, suscribir y publicar con cada modo; rechazo con clave, token o seed incorrectos y sin autenticación; seed pegado con espacios; `.creds` con `~`. Prueba de humo: los 4 modos desde el store y el árbol de VS Code. Corregido: un seed inválido esperaba 10 s y fallaba con `TIMEOUT` (ahora error inmediato "Invalid NKey seed"); el seed se recorta; la ruta de `.creds` acepta `~` y un archivo inexistente da un error claro.
- Historial (S5): 4 pruebas unitarias (orden, límite y compactación, línea cortada por un cierre abrupto, apagado y limpieza) y prueba de humo con los 5 motores SQL (sentencia correcta y fallida con su error y duración, insertar desde **Query History…** en un editor vinculado) y Redis (comandos, db y error). No verificado a mano: los botones del selector (abrir en editor nuevo, copiar, limpiar).

### Verificación (v0.5.0)

- `npm test` con `DBCLIENT_*`: 57 pruebas (2 omitidas: estado de sesión y cancelación no aplican a SQLite).
  - Unitarias: división de sentencias por dialecto, `ConnectionStore`, parser de líneas Redis, formato de respuestas, agrupación de llaves.
  - Integración contra los contenedores locales: PostgreSQL 15, MySQL 8.4, SQL Server 2022, Oracle Free (FREEPDB1), SQLite (archivo temporal), Redis 7.2 (db 15, prefijo único) y NATS 2.12 con JetStream (stream temporal). Cubren filas afectadas, tipos, truncado, error con línea/posición, estado de sesión, cancelación y árbol.
- `npm run test:smoke`: VS Code real; por cada motor SQL: árbol, ejecutar archivo, error en la línea correcta del editor, ejecutar la sentencia bajo el cursor; Redis: árbol, autocompletado de comandos y opciones, ejecutar archivo, error en la línea, visor de valores; NATS: árbol, consola, suscribir/publicar.
- `npm run package` genera `dbclient-0.5.0.vsix` (1,4 MB, sin dependencias nativas).
- Ubicaciones SQL (S11): 9 pruebas unitarias (expansión de rutas, contención, ubicaciones y guardado, ruta más específica y empates, listado con omisiones y límite) y prueba de humo en VS Code: carpetas vinculadas con subcarpetas, omisión de `.git`/`node_modules`, `${workspaceFolder}` sin proyecto marcado, vínculo por la carpeta más específica, empate sin vínculo, ejecutar un archivo vinculado, cambio de la ubicación de guardado, detección de un archivo creado fuera del editor, desvincular sin borrar y borrar conexiones sin tocar las carpetas vinculadas. No verificado a mano: los diálogos de selección de carpeta, la pregunta de empate y la sección del formulario; `${workspaceFolder}` con un proyecto abierto solo tiene prueba unitaria.
- Archivos SQL (S9): 6 pruebas unitarias del almacenamiento (nombres únicos, conexión implícita, renombrar, eliminar, reubicar) y prueba de humo (nodo SQL, contador, vínculo automático, ejecutar el archivo guardado).
- Excel (S10): pruebas unitarias del escritor (ZIP verificado con CRC, celdas tipadas, precisión, fechas) y un archivo con resultados reales de PostgreSQL abierto en Microsoft Excel por AppleScript: sin reparación, números, fechas y booleanos como valores de Excel. Postgres ahora entrega `date`/`time`/`timestamp` como texto del servidor (antes `date` se corría de día por la zona horaria); prueba de integración incluida.
- Carpetas (C4): pruebas unitarias del store (anidar, mover, ciclos, eliminar sube el contenido, carpeta inexistente, duplicar) y prueba de humo en VS Code (árbol anidado y arrastrar y soltar).
- Documentación: `README.md` (inglés, incluido en el `.vsix`) y `README.es.md` (traducción): instalación, funcionalidades, ejemplos de uso, configuración y desarrollo.
- Sin verificar de forma automática: el aspecto visual de los webviews, la edición de valores desde el visor de Redis, la consola NATS en uso interactivo y las autenticaciones de NATS con usuario/token/nkey/credenciales.

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
| 2026-10-12 | Drivers MySQL, SQL Server, Oracle y SQLite (D2–D5); Redis con árbol, editor `.redis` y visor de valores (R1–R3); NATS con consola y JetStream (N2–N4, N1 parcial); iconos de `img/` integrados | 24,8 % |
| 2026-10-12 | Documentación: `README.md` y su traducción `README.es.md`; contexto de agentes actualizado. Sin cambios de requisitos ni de implementación | 24,8 % |
| 2026-10-12 | Carpetas para agrupar conexiones (C4): anidadas, crear/renombrar/eliminar/mover, arrastrar y soltar, campo Folder en el formulario | 22,9 % |
| 2026-10-12 | Carpeta SQL por conexión (S9, 3 pts) y exportación a Excel (S10, 2 pts), nuevos y completos; total 107 → 112 pts; corrección de fechas de PostgreSQL | 21,9 % |
| 2026-10-12 | Ubicaciones SQL por conexión (S11, 3 pts): carpetas vinculadas y ubicación de guardado; total 112 → 115 pts | 21,3 % |
| 2026-10-12 | Autenticaciones NATS verificadas con servidores temporales (N1 completo; seed inválido sin espera, `~` en `.creds`) e historial de consultas por conexión SQL y Redis (S5) | 18,3 % |
| 2026-10-12 | Acciones sobre tablas desde el árbol (S6), autocompletado de objetos reales con alias (S4) y edición de datos en la grilla con DML por clave primaria en una transacción (S8); bloque S completo | 7,0 % |
| 2026-10-12 | Exportar e importar conexiones y carpetas sin secretos, fusionando o reemplazando (C5) | 5,2 % |
| 2026-10-12 | SSL/TLS en PostgreSQL, MySQL, SQL Server, Oracle (TCPS), Redis y NATS (C6 en 0,5) | 3,5 % |
| 2026-10-12 | Túnel SSH para todos los motores de red (C6 completo) | 1,7 % |
| 2026-10-12 | Interfaz en español: código, manifiesto, webviews y formularios traducidos y verificados por pruebas; falta verla en el editor (F3 en 0,5) | 0,9 % |
