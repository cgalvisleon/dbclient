# dbclient — Especificación y brecha

Fuente: `feature.md`. Este documento detalla los requisitos y mide la brecha entre lo implementado y el objetivo. **Se actualiza con cada cambio del proyecto** (estado de cada requisito, cálculo de la brecha e historial).

## 1. Objetivo

Extensión de VS Code (y editores compatibles como Cursor) llamada `dbclient`: un cliente de bases de datos al estilo de *Database Client* (`cweijan.vscode-database-client2`), con soporte para PostgreSQL, SQLite, MySQL, MSSQL, Oracle, Redis y NATS. La configuración de conexiones se guarda en un solo lugar, las bases SQL y Redis tienen editor con autocompletado, y NATS permite publicar y suscribirse.

## 2. Arquitectura

Estado: ✅ implementado · ◐ parcial.

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
| `l10n/` + `package.nls*.json` + `media/l10n.js` + `src/l10n.ts` | Traducciones al español y al portugués de Brasil del código (`t()` de `src/l10n.ts`, que sigue al editor o al idioma elegido en `dbclient.language`), del manifiesto y de los webviews (la extensión inyecta el diccionario del idioma activo). | ◐ (falta ver el modo automático en el editor) |
| `src/connections/manager.ts` | Instancias vivas de drivers; conectar, desconectar, probar; cambios del driver refrescan solo su rama del árbol. | ✅ |
| `src/tree/` | `TreeDataProvider` genérico: SQL, Redis y NATS en el mismo listado, agrupados en carpetas (arrastrar y soltar, mover, renombrar, eliminar); iconos de `img/`. | ✅ |
| `src/editor/` | `bindings.ts` (conexión de cada editor `.sql`/`.redis`, barra de estado, cambio con confirmación), `statements.ts` (división por dialecto: `GO`, `DELIMITER`, `/` y bloques PL/SQL, triggers), `sqlRunner.ts`, `gridEditor.ts` (edición en la grilla), `tableActions.ts` (acciones de tablas), `historyPicker.ts`, `redisRunner.ts` (una orden por línea, confirma FLUSHDB/FLUSHALL), `codeLens.ts`. | ✅ |
| `src/completion/` | Diccionarios ANSI + PostgreSQL, MySQL, SQL Server, Oracle y SQLite; con la conexión abierta, esquemas, tablas, vistas y columnas reales (`connections/catalog.ts`, caché por conexión) resolviendo alias; catálogo de ~110 comandos Redis con opciones y sugerencia de llaves existentes. | ✅ |
| `src/sql/` | Puro: `parse.ts` (tokens, tablas con alias, SELECT de una tabla, contexto de autocompletado), `identifiers.ts` (comillas y marcadores por dialecto), `generate.ts` (plantillas, estructura, CREATE TABLE, DML de la grilla), `editable.ts` (columnas editables del resultado). | ✅ |
| `src/webviews/` + `media/` | Formulario de conexión; panel *Results* (pestañas, paginación, orden, copiar, exportar CSV/JSON/Excel, edición de celdas y filas con confirmar/cancelar, *Output*); visor/editor de valores Redis; consola NATS. | ✅ |
| `src/store/sqlFiles.ts` | Archivos `.sql` guardados por conexión en `<raíz>/<connectionId>/`; crear en cualquier carpeta; `FolderWatcher` para carpetas vinculadas. | ✅ |
| `src/store/sqlLocations.ts` + `src/connections/sqlLocations.ts` | Ubicaciones por conexión (interna, vinculadas, de guardado), expansión de `~`/`${workspaceFolder}`, dueño de un archivo por la ruta más específica, listado con límites. | ✅ |
| `src/export/xlsx.ts` | Escritor `.xlsx` sin dependencias (ZIP + SpreadsheetML): encabezado en negrita y congelado, filtro, números y fechas tipados sin perder precisión. | ✅ |
| `scripts/build-icons.mjs` | Recorta los iconos de `img/` (quita la etiqueta y el halo oscuro) y genera `media/icons/` (variantes clara y oscura) y `media/icon.png`. | ✅ |

Librerías: `pg`, `pg-cursor`, `mysql2`, `mssql`, `oracledb`, `ioredis`, `nats` y `ssh2` para túneles (todas JavaScript puro; `ssh2` sin sus módulos nativos opcionales), además de `node:sqlite`. Build con `esbuild`, empaquetado con `@vscode/vsce`.

## 3. Requisitos

Estado: `0` pendiente · `0.5` parcial · `1` completo. Peso total = 117 (los pesos son puntos; la brecha se expresa en % del total, ver §4).

### F — Fundación (10)

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| F1 | Proyecto TypeScript de extensión (manifest `dbclient`, build esbuild, empaquetado `.vsix`, funciona en VS Code y Cursor) | 4 | 1 |
| F2 | Interfaz común de drivers y registro; agregar un motor no exige tocar árbol, editor ni grilla | 4 | 1 |
| F3 | Interfaz en inglés, español y portugués de Brasil: textos de la extensión, manifiesto (`package.nls`), webviews y campos de los formularios; el idioma sigue al de VS Code/Cursor por defecto y se puede elegir en `dbclient.language` o en el panel de configuración | 2 | 0.5 |

### C — Conexiones y persistencia (29)

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| C1 | Panel en la barra de actividad con árbol de conexiones (SQL: BD/esquema > tablas, vistas, funciones, procedimientos, índices; Redis: db > llaves por prefijo; NATS: streams/subjects y suscripciones) | 6 | 1 |
| C2 | Formulario de conexión: crear, editar, duplicar, eliminar, probar, conectar y desconectar (al desconectar se contrae su detalle en el árbol); botón **Ver/Ocultar** en los campos de contraseña | 6 | 1 |
| C3 | Persistencia centralizada a nivel usuario (`globalStorage`) con secretos en `SecretStorage` | 6 | 1 |
| C4 | Carpetas para agrupar conexiones | 2 | 1 |
| C5 | Exportar e importar la configuración (sin secretos): todo, una carpeta o las conexiones seleccionadas; importar dentro de una carpeta; importar fusionando (conserva lo existente, omite lo idéntico, copia renombrada si hay conflicto) o reemplazando (con confirmación); los ids se conservan para que una copia restaurada recupere sus claves y archivos SQL | 2 | 1 |
| C6 | SSL/TLS (desactivado / requerido / verificar todo; CA, certificado y clave del cliente con frase) y túnel SSH (contraseña o clave privada con frase, huella de la llave del host) en todos los motores de red | 4 | 1 |
| C7 | Panel **Configuración y acerca de** (botón ⚙ en el título de la vista): rutas de la persistencia (almacenamiento, `connections.json`, historial, archivos SQL) con copiar y abrir carpeta, dónde están los secretos, configuración `dbclient.*` actual frente al valor por defecto, entorno, y acerca de con la versión y los enlaces de GitHub del autor | 1 | 1 |
| C8 | Apariencia de cada conexión: icono (6 formas) y color (azul y 6 más: verde, rojo, naranja, morado, amarillo, gris) elegidos en el formulario con vista previa, en temas claro y oscuro; las carpetas de conexiones también tienen color (**Cambiar color…**); se exportan e importan con la conexión o la carpeta | 1 | 1 |
| C9 | Actualizar una conexión o un nodo (base, esquema, carpeta, tabla, vista) desde el árbol para ver los cambios hechos fuera (esquemas o tablas creados o borrados); tras ejecutar DDL en el editor, la conexión se actualiza sola | 1 | 0.5 |

### D — Drivers SQL (16)

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| D1 | PostgreSQL | 4 | 1 |
| D2 | SQLite | 3 | 1 |
| D3 | MySQL | 3 | 1 |
| D4 | MSSQL | 3 | 1 |
| D5 | Oracle (por host y servicio o por URL JDBC: servicio, SID, `tcps://`, descriptor o alias de tnsnames.ora) | 3 | 1 |

### S — Editor SQL (49)

Referencia funcional: el editor SQL de NetBeans (selector de conexión en el editor, ejecutar archivo o sentencia con atajos, resultados en pestañas bajo el editor, paginación de filas traídas, salida SQL con tiempos y errores navegables, edición de datos en la grilla).

| ID | Requisito | Peso | Estado |
|---|---|---|---|
| S1 | Archivo `.sql` asociado a una conexión, visible en la primera línea del editor (CodeLens `Connection:` con selector de conexión y base; en la barra de título botones para ejecutar el archivo o la selección, copiar, pegar y guardar, y **■ Cancel** mientras corre una consulta —también en el CodeLens de la sentencia en curso—, y en su menú `…` ejecutar la sentencia, cambiar/conectar/desconectar, historial, exportar, importar y abrir en el editor SQL propio) y en la barra de estado, con cambio de conexión confirmado; ejecutar archivo, selección o sentencia bajo el cursor con atajos; cancelar | 5 | 1 |
| S2 | Resultados en pestañas bajo el editor (una por sentencia, conservadas entre ejecuciones hasta 50 salvo que se apague, reordenables arrastrando, con Output fija en primer lugar); grilla con paginación de filas traídas (avance/retroceso), ordenar, copiar, exportar CSV/JSON | 6 | 1 |
| S3 | Autocompletado de palabras clave y funciones según el dialecto del driver | 4 | 1 |
| S4 | Autocompletado de objetos reales (esquemas, tablas, vistas, columnas) resolviendo alias | 5 | 1 |
| S5 | Historial de consultas por conexión (SQL y Redis): sentencia, base, duración, filas o error; búsqueda, insertar en el editor o abrir en uno nuevo, copiar, limpiar; tamaño configurable (`dbclient.historySize`, 0 lo apaga) y sin comandos con credenciales | 2 | 1 |
| S6 | Acciones desde el árbol: estructura de tabla, abrir datos, abrir la SQL sin ejecutarla, DDL, generar SELECT/INSERT/UPDATE/DELETE | 4 | 1 |
| S7 | Salida SQL: registro por sentencia con tiempo de ejecución, filas afectadas y errores con línea/columna que navegan al editor; limpiar el registro y reiniciar la numeración de consultas | 3 | 1 |
| S8 | Edición de datos en la grilla: editar celdas, insertar y eliminar filas, confirmar o cancelar (genera el DML por clave primaria) | 4 | 1 |
| S9 | Carpeta SQL por conexión y por base de datos: archivos `.sql` persistentes, vinculados a su conexión (y base) al abrirlos; crear, renombrar, eliminar, guardar (botón en archivos sin guardar), guardar la consulta actual; ubicación configurable | 3 | 1 |
| S10 | Exportar resultados a Excel (`.xlsx`) con números y fechas como valores de Excel | 2 | 1 |
| S11 | Ubicaciones SQL por conexión: vincular carpetas existentes con archivos `.sql` (subcarpetas, `~` y `${workspaceFolder}`), vínculo automático por la carpeta más específica (empate: se pregunta y se recuerda), ubicación de guardado configurable, vigilancia de cambios externos; desvincular nunca borra archivos | 3 | 1 |
| S12 | Eliminar desde el árbol según el motor: tablas y vistas en todos los SQL (CASCADE en PostgreSQL, CASCADE CONSTRAINTS en Oracle; vistas materializadas en PostgreSQL) y esquemas en PostgreSQL y SQL Server, bases en MySQL y usuarios en Oracle; confirmación modal con el `DROP`, y para esquemas escribir el nombre | 2 | 0.5 |
| S13 | Menú contextual de una celda del resultado: copiar valor, copiar registro (TSV o JSON) y generar INSERT/UPDATE/DELETE del registro con literales del dialecto (por clave primaria; sin ella, por todas las columnas con aviso) en un editor vinculado | 2 | 0.5 |
| S14 | Editor SQL propio de DB Client (opcional, al estilo NetBeans): barra con listas de conexión y base y botones de icono, editor con resaltado (CodeMirror) y resultados en la misma pestaña; el archivo sigue siendo un documento de VS Code. Entrega 1: barra, edición sincronizada, ejecutar archivo/sentencia/selección, detener, conectar, historial, guardar, copiar/pegar/exportar/importar, resultados propios, apertura por defecto opcional. Entrega 2 (pendiente): autocompletado, errores subrayados en el texto y ▶ por sentencia | 4 | 0.5 |

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
total   = Σ peso                      (hoy 126)
avance  = Σ (peso × estado)
brecha  = (total − avance) / total × 100 %
```

| Bloque | Peso | Avance | Brecha (pts) |
|---|---|---|---|
| F — Fundación | 10 | 9 | 1 |
| C — Conexiones y persistencia | 29 | 28,5 | 0,5 |
| D — Drivers SQL | 16 | 16 | 0 |
| S — Editor SQL | 49 | 45 | 4 |
| R — Redis | 11 | 11 | 0 |
| N — NATS | 11 | 11 | 0 |
| **Total** | **126** | **120,5** | **5,5** |

**Brecha actual: 4,4 % (5,5 de 126 pts)** — los 7 motores funcionan en el mismo listado de conexiones, agrupables en carpetas; el editor SQL está completo al estilo NetBeans: archivos y ubicaciones `.sql`, historial, acciones sobre tablas desde el árbol, autocompletado de esquemas, tablas y columnas con alias, y edición de datos en la grilla; los resultados se exportan a Excel y NATS está verificado con todas sus autenticaciones; la configuración se exporta e importa sin secretos y un panel muestra dónde se guarda todo; las conexiones de red usan SSL/TLS y túnel SSH, y la interfaz está traducida al español y al portugués de Brasil, con idioma elegible. Falta: la segunda entrega del editor SQL propio (S14: autocompletado, errores en el texto y ▶ por sentencia); ver el modo automático (idioma del editor) dentro de VS Code/Cursor (F3 parcial: el VS Code de pruebas no tomó el idioma por argumento; el idioma elegido con `dbclient.language` sí está verificado); probar en Cursor la actualización por nodo (C9) y el borrado desde el árbol, y verificar el `DROP` contra MySQL, SQL Server y Oracle (S12: verificado en PostgreSQL y SQLite); verificar contra MySQL, SQL Server y Oracle el SQL generado desde un registro y ver el menú contextual en Cursor (S13: verificado en PostgreSQL y SQLite).

## 5. Orden sugerido para cerrar la brecha

1. ✅ **MVP (48 pts):** F1, F2, C1, C2, C3, D1, S1, S2, S3, S7. Una conexión PostgreSQL que se crea, se guarda y se consulta desde un `.sql` con autocompletado de palabras clave, resultados en pestañas y salida SQL.
2. ✅ **SQL completo (+29):** D2–D5 (12), C4 (2), S4–S8 (15).
3. ✅ **Redis (+11):** R1–R3.
4. ✅ **NATS (+11):** N1–N4.
5. ◐ **Cierre (+8):** ✅ C5 (2), ✅ C6 (4), ◐ F3 (1 de 2: falta verla en el editor).

### Verificación (editor SQL propio, entrega 1)

- S14: prueba de humo en el VS Code de pruebas: el editor se abre con **Open in DB Client SQL Editor**, CodeMirror carga dentro de la webview (con la CSP y el nonce de estilos), la barra muestra la conexión del archivo, una edición de la webview llega al documento (queda sin guardar), ejecutar el archivo y la sentencia del cursor envía los resultados al editor y no al panel inferior, y funciona con documentos sin título. Prueba en jsdom (`test/unit/sqlEditorWebview.test.ts`, CodeMirror simulado): listas agrupadas por carpeta con **Add Connection…**, conectar/desconectar y detener según el estado, ediciones enviadas antes de ejecutar, insertar texto, actualizaciones del documento y resultados incrustados con el documento en el menú contextual. Sin verificar a mano dentro de Cursor (aspecto, atajos, deshacer).

### Verificación (actualizar y eliminar desde el árbol)

- `dropSql`/`canCascade` (pruebas unitarias en los 5 dialectos). Integración (`metadata.test.ts`): eliminar vista, tabla con CASCADE y esquema por `driver.transaction`, verificado en PostgreSQL (incluido `DROP SCHEMA … CASCADE`) y SQLite; los casos de MySQL (`DROP DATABASE`), SQL Server y Oracle están escritos pero no se ejecutaron (contenedores apagados). Sin verificar a mano: botones y menús del árbol, confirmaciones y la actualización tras DDL en Cursor.

### Verificación (v0.12.1)

- Color de carpetas (C8): `explorer.png` generado en los 6 colores (revisado en una vista previa clara y oscura); comando **Change Color…** sobre la carpeta (selector con el color actual marcado; azul quita el color). Pruebas unitarias (persistencia, volver al predeterminado, carpeta inexistente, el color viaja al exportar e importar; archivos de cada color y tema) y de humo (el árbol usa `colors/orange/explorer.png` y su variante clara, azul limpia el color). Sin verificar a mano: el selector y el árbol en Cursor.

### Verificación (v0.11.0)

- Iconos y colores (C8): `scripts/build-icon-colors.mjs` (con `scripts/png.mjs`) genera `media/icons/colors/<color>/` girando el tono del azul (≈212°) y conservando sombras, blancos y transparencia; revisados en una hoja de vista previa sobre fondo claro y oscuro. Pruebas: unitarias (cada forma × color × tema existe, recoloreado de un píxel azul, blanco, gris y transparente; sección **Apariencia** del formulario en jsdom: 7 formas y 7 colores con vista previa, conserva lo escrito al re-renderizar, envía `icon`/`color` al guardar y los limpia con Automático y azul) y de humo (el árbol usa `colors/purple/cloud-database.png` y su variante clara). Sin verificar a mano: el aspecto del formulario y del árbol en Cursor.
- Exportar/importar individual (C5): exportar las conexiones elegidas sin carpetas (conservando icono y color) e importar dentro de una carpeta (sus carpetas y conexiones quedan adentro; **Replace** no se ofrece) con 2 pruebas unitarias del store y prueba de humo con los argumentos que pasa el árbol (elemento + selección y carpeta destino). Sin verificar a mano: los menús contextuales en Cursor.

### Verificación (v0.10.0)

- Configuración y acerca de (C7): `src/webviews/settings.ts` + `media/settings.{js,css}`, comando `dbclient.showSettings` con el botón ⚙ en el título de la vista. Prueba unitaria en jsdom (`test/unit/settingsWebview.test.ts`: secciones, ruta aún no creada, valor vacío, origen del valor, autor y `@cgalvisleon`, mensajes de copiar, mostrar en carpeta, abrir configuración y enlace) y prueba de humo en VS Code 1.141 (el comando abre una sola pestaña aunque se llame dos veces). La extensión solo abre los enlaces y rutas que ella misma envió al panel. Sin verificar a mano: el aspecto del panel en Cursor.
- Oracle TCPS contra un servidor real (C6, D5): conexión a una Oracle Autonomous Database 19c por endpoint privado (VPN) con `tcps://<ip>:1521/<servicio>` y SSL **require**, sin wallet ni archivos PEM (solo conectar y cerrar, sin SQL); también en el puerto 1522. Sin TLS el servidor cierra la conexión (`NJS-500`) y **verify-full** con una IP falla el handshake (`NJS-506`), porque el certificado es de `*.adb.oraclecloud.com`.

### Verificación (v0.9.0)

- `npm run test:integration` (archivos en serie: en paralelo, con todos los entornos de prueba arriba, Oracle y SQL Server superan los tiempos de espera en esta máquina): 149 pruebas, 2 omitidas; `npm run test:smoke` completo con los 7 motores, SSL y SSH; `npm run package` genera `dbclient-0.9.0.vsix` sin módulos nativos.
- SSL/TLS (C6): `scripts/tls-fixture.sh` crea una CA y certificados de servidor y cliente y levanta PostgreSQL, MySQL, Redis y NATS con TLS y un proxy TLS (`socat`) delante del Oracle local. 6 pruebas de integración: PostgreSQL (sin SSL rechazado, `require`, `verify-full` con CA, CA desconocida rechazada, archivo inexistente, usuario con certificado de cliente, clave cifrada con frase correcta e incorrecta), MySQL (transporte seguro y `REQUIRE X509`), Redis y NATS (certificado de cliente obligatorio), Oracle TCPS en modo *thin* contra el proxy (el Oracle en sí no se configuró con TCPS) y SQL Server cifrado con y sin verificar su certificado autofirmado. Prueba de humo: PostgreSQL `verify-full` con certificado de cliente desde el store y el árbol.
- Túnel SSH (C6): `scripts/ssh-fixture.sh` levanta un `sshd` temporal. 4 pruebas de integración: PostgreSQL con contraseña, Redis con clave, NATS con clave cifrada, MySQL con huella del host; rechazos por contraseña, frase o huella incorrectas y archivo inexistente; el puerto local se cierra con el túnel. Prueba de humo: PostgreSQL y Redis por túnel y TLS dentro del túnel, con `ssh2` empaquetado (sin sus módulos nativos opcionales). 6 pruebas unitarias (destino y reescritura del túnel, opciones TLS, campos en todos los motores de red, secciones del formulario en jsdom). Corregido: un campo recién visible del formulario perdía su valor por defecto (el puerto SSH aparecía vacío).
- URL JDBC de Oracle (D5, v0.9.2): `src/drivers/oracleUrl.ts` traduce la URL a Easy Connect o a un descriptor (`SID`), respeta `tcps://` y `TNS_ADMIN`, y la reescribe para el túnel SSH; el formulario mueve usuario y contraseña de la URL a sus campos antes de probar o guardar (`DriverFactory.prepare`). 10 pruebas unitarias (formatos, SID, TLS, descriptor, alias, credenciales, ida y vuelta, túnel, formulario en jsdom con una conexión guardada sin `connectBy`) y 5 de integración contra un Oracle Free temporal: servicio con y sin `//`, descriptor, SID (aceptado por el listener; uno inexistente se rechaza), credenciales en la URL y descriptor a través del túnel SSH de `scripts/ssh-fixture.sh`. Las pruebas de Oracle por host y servicio siguen pasando. Sin verificar: el alias con `TNS_ADMIN` contra un tnsnames.ora real y el formulario dentro de Cursor.
- Ver contraseña (C2, v0.9.1): cada campo de contraseña del formulario (base, SSH, frases de clave, NKey…) tiene un botón **Show/Hide** (**Ver/Ocultar**) que alterna el tipo del campo; prueba unitaria en jsdom (un botón por campo, alterna y conserva lo escrito, `aria-pressed`). Una contraseña ya guardada no se envía al formulario, así que solo se ve lo que se escribe.
- Idiomas (F3): 286 textos en `l10n/bundle.l10n.es.json` y 52 del manifiesto en `package.nls.es.json`; prueba unitaria que extrae todas las claves (`l10n.t` del código, `t()` de los webviews, campos de los drivers y palabras del árbol) y exige traducción completa, sin claves sobrantes y con los mismos marcadores `{n}`; prueba del inyector de traducciones de los webviews. Portugués de Brasil (2026-10-20): `l10n/bundle.l10n.pt-br.json` y `package.nls.pt-br.json` con las mismas pruebas que el español; idioma elegible con `dbclient.language` (prueba de humo: con `pt-br` la barra del editor dice `Conexão:` y vuelve al inglés al quitar el ajuste) y selector en el panel de configuración (prueba en jsdom). Sin verificar: el modo automático (idioma del editor) dentro de VS Code/Cursor (el VS Code de pruebas siguió en inglés con `--locale es`, incluso con el paquete de idioma instalado), y los títulos de comandos del manifiesto, que solo siguen al editor.

### Verificación (v0.8.0)

- `npm test`: 126 pruebas (6 omitidas sin los servidores de autenticación NATS); `npm run test:smoke` completo con los 7 motores; `npm run package` genera `dbclient-0.8.0.vsix`.
- Exportar e importar (C5): 5 pruebas unitarias (sin secretos aunque una entrada vieja los tenga en `options`, exportar una carpeta con sus subcarpetas, restaurar con los mismos ids y recuperar la clave, carpetas reutilizadas, conflictos de id y de nombre como copias renombradas, motores desconocidos ignorados, reemplazar borra lo que no está en el archivo y sus secretos, archivos inválidos) y prueba de humo en VS Code con los comandos (todo y una carpeta, restaurar, importar dos veces sin duplicar, reemplazar). No verificado a mano: los diálogos de archivo, el selector Merge/Replace y la confirmación de Replace.

### Verificación (v0.7.0)

- `npm test`: 121 pruebas (6 omitidas sin los servidores de autenticación NATS); `npm run test:smoke` completo con los 7 motores; `npm run package` genera `dbclient-0.7.0.vsix`.
- Contrato nuevo de `SqlDriver` (`catalog`, `describe`, `ddl`, `transaction`) en los 5 motores: 20 pruebas de integración (catálogo de tablas y vistas, columnas, clave primaria compuesta e índices, nombre sin esquema y en minúsculas, DDL de tabla con su índice y de vista, transacción con actualización e inserción, fechas que vuelven intactas, reversión completa cuando una clave no existe).
- Acciones del árbol (S6): prueba de humo por motor: nodo de tabla con su nombre real, plantillas SELECT/INSERT/UPDATE/DELETE, DDL en un editor vinculado y las dos pestañas de estructura (columnas e índices).
- Autocompletado (S4): pruebas unitarias del lector SQL (tablas con alias en FROM con comas, JOIN, UPDATE, INSERT, subconsultas; contexto tabla/columna/miembro) y prueba de humo por motor: columnas tras `alias.` y tablas tras `FROM`.
- Edición en la grilla (S8): pruebas unitarias del mapeo (`*` por nombre, listas por posición, expresiones y duplicados de solo lectura, motivos: vista, sin clave primaria, clave ausente) y del DML parametrizado por dialecto; prueba de humo por motor: **Open Data** editable, confirmar actualización + inserción + eliminación y recarga de las filas guardadas, rechazo con reversión de una clave vieja, motivo de solo lectura; prueba del webview real (`media/results.js`) en jsdom: doble clic, Enter/Escape/Tab, columnas de solo lectura, NULL, fila nueva con DEFAULT, eliminar, confirmar y su respuesta, error que conserva los cambios, cancelar y texto que sobrevive a un redibujado. No verificado a mano: el aspecto visual de la grilla editable en VS Code/Cursor.
- Conexión del editor (S1): prueba de humo del CodeLens en la línea 0 con el nombre de la conexión, cambio cancelado que conserva la conexión, cambio confirmado que la aplica y misma conexión sin pregunta. Pestañas de resultados (S2): prueba en jsdom de Output primero, pestañas conservadas entre ejecuciones, arrastre (incluido soltar sobre Output), pestaña activa tras moverla, **Keep tabs** apagado y límite de 50. No verificado a mano: el arrastre y el diálogo de confirmación dentro de Cursor.
- Menú del registro (S13) y limpiar la salida (S7): pruebas unitarias de `sqlLiteral` (NULL, booleanos, enteros grandes como texto, comillas, barra invertida en MySQL, `N''` en SQL Server, `TIMESTAMP` en Oracle) y de `rowSql` (por clave y por todas las columnas); prueba en jsdom de **Clear** (registro vacío y numeración desde 1), del `data-vscode-context` de las celdas y de las acciones de copiar y generar; prueba de humo en SQLite y PostgreSQL: DELETE sin clave y UPDATE por clave generados en un editor vinculado y ejecutados sin error. No verificado: MySQL, SQL Server y Oracle (contenedores apagados) y el menú nativo dentro de Cursor.
- Carpeta SQL por base y barra del editor (S9, S1): prueba unitaria de `databaseDir`/`databaseOf` (nombres codificados, subcarpetas, fuera del listado de la conexión); prueba de humo: archivo de la carpeta de una base vinculado a esa base, **Save** escribe el editor abierto, botones de la barra en la línea 0. Visto en capturas del VS Code de pruebas contra PostgreSQL: nodo **SQL** en cada base, archivo `● unsaved` con su botón, barra completa y selector de conexión y luego de base.

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
- Sin verificar de forma automática: el aspecto visual de los webviews, la edición de valores desde el visor de Redis, la consola NATS en uso interactivo y las autenticaciones de NATS con usuario/token/nkey/credenciales (estas últimas verificadas en v0.6.0).

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
| 2026-10-13 | Botón para ver u ocultar la contraseña en el formulario de conexión (C2, sin cambio de puntaje) | 0,9 % |
| 2026-10-13 | Conexión Oracle por URL JDBC (D5, sin cambio de puntaje) | 0,9 % |
| 2026-10-16 | Panel de configuración y acerca de con las rutas de la persistencia, la configuración actual, el entorno y los enlaces de GitHub del autor (nuevo C7, 1 pt; total 116; v0.10.0) | 0,9 % |
| 2026-10-16 | Correcciones de `spec.md`: fila de i18n duplicada y desactualizada, `ssh2` ya en uso, autenticaciones NATS ya verificadas; Oracle TCPS verificado contra una Autonomous Database real. Sin cambio de puntaje | 0,9 % |
| 2026-10-16 | Icono y color por conexión (nuevo C8, 1 pt; total 117) y exportar/importar individual o dentro de una carpeta (C5, sin cambio de puntaje); v0.11.0 | 0,9 % |
| 2026-10-16 | Nueva versión empaquetada (v0.11.1) sin cambios funcionales | 0,9 % |
| 2026-10-16 | Color del icono de las carpetas de conexiones (C8, sin cambio de puntaje); v0.12.0 | 0,9 % |
| 2026-10-16 | Color de carpeta visible (botón en la fila y comando en la paleta); preparación para publicar: licencia MIT, `CHANGELOG.md`, categorías y palabras clave, scripts `publish:ovsx`/`publish:vsce` y workflow de release en GitHub (sin cambio de puntaje) | 0,9 % |
| 2026-10-16 | Nueva versión empaquetada (v0.12.1) sin cambios funcionales | 0,9 % |
| 2026-10-16 | `deploy.sh`: `--build` empaqueta el `.vsix` y `--deploy` lo publica en Open VSX con `OVSX_PAT` y `--marketplace` en el VS Code Marketplace con `VSCE_PAT` (sin cambio de puntaje) | 0,9 % |
| 2026-10-16 | Icono de la tienda redibujado en SVG (`img/db-client.svg`) y exportado a 256 px (antes 128 px borroso); `version.sh` también actualiza `package.json` y lo confirma antes de etiquetar (sin cambio de puntaje) | 0,9 % |
| 2026-10-16 | Página de la tienda: insignias de Open VSX y licencia, frase de resumen, párrafo con lo que distingue a la extensión (gratuita, MIT, sin módulos nativos, Redis y NATS) y lugares marcados para GIFs en ambos README; la instalación ya no dice que está en el VS Code Marketplace (solo está en Open VSX); 11 palabras clave más (sin cambio de puntaje) | 0,9 % |
| 2026-10-18 | Actualizar una conexión o un nodo del árbol y actualización automática tras DDL (nuevo C9, 1 pt, en 0,5); eliminar tablas, vistas y esquemas según el motor desde el árbol (nuevo S12, 2 pts, en 0,5: verificado en PostgreSQL y SQLite); total 117 → 120; v0.13.0 | 2,1 % |
| 2026-10-18 | Nombre visible **DB Client: SQL, Redis & NATS** ("DB Client" ya existe en el VS Code Marketplace) y primera publicación en el Marketplace; v0.13.1 (sin cambio de puntaje) | 2,1 % |
| 2026-10-18 | Documentación: instalación desde el VS Code Marketplace (VS Code) y Open VSX (Cursor, VSCodium, Windsurf) e insignia del Marketplace en ambos README (sin cambio de puntaje) | 2,1 % |
| 2026-10-18 | v0.13.2: la página de ambas tiendas muestra la instalación corregida (sin cambios funcionales ni de puntaje) | 2,1 % |
| 2026-10-19 | **Open SQL** en el menú de tablas y vistas: abre el `SELECT * FROM` de **Open Data** en un editor vinculado sin ejecutarlo (S6, sin cambio de puntaje); v0.14.0 | 2,1 % |
| 2026-10-19 | La conexión del editor SQL/Redis en su primera línea (CodeLens con **Change Connection…**, `dbclient.connectionLens`) y cambio de conexión con confirmación modal; prueba de humo (S1, sin cambio de puntaje) | 2,1 % |
| 2026-10-19 | Panel de resultados: **Output** fija en primer lugar, pestañas conservadas entre ejecuciones por defecto (máximo 50), reordenables arrastrando y cierre con clic central; pruebas en jsdom (S2, sin cambio de puntaje); v0.15.0 | 2,1 % |
| 2026-10-20 | Botón **Clear** en Output (vacía el registro y reinicia la numeración, S7) y menú contextual de las celdas: copiar valor, copiar registro (TSV/JSON) y generar INSERT/UPDATE/DELETE del registro (nuevo S13, 2 pts, en 0,5: verificado en PostgreSQL y SQLite); total 120 → 122; v0.16.0 | 2,9 % |
| 2026-10-20 | Carpeta **SQL** por base de datos en el árbol (archivos vinculados a esa base) y botón **Save** en archivos sin guardar (S9); barra en la primera línea del editor con selector de conexión y base, ejecutar todo/sentencia/selección, copiar, pegar, exportar e importar (S1). Sin cambio de puntaje; v0.17.0 | 2,9 % |
| 2026-10-20 | Barra del editor al estilo NetBeans (S1): `Connection:` con la conexión como lista desplegable y botones solo de icono con descripción emergente; nuevos botones detener (solo mientras corre una consulta), conectar/desconectar, historial y guardar en la carpeta SQL; las mismas acciones en el menú `…` del título del editor. Sin cambio de puntaje; v0.18.0 | 2,9 % |
| 2026-10-20 | Documentación: versión en portugués de Brasil (`README.pt.md`), enlazada desde los README en inglés y español; la interfaz sigue en inglés y español (sin cambio de puntaje) | 2,9 % |
| 2026-10-20 | Interfaz en portugués de Brasil (`l10n/bundle.l10n.pt-br.json`, `package.nls.pt-br.json`) y ajuste `dbclient.language` (`auto` por defecto = idioma del editor, `en`, `es`, `pt-br`) con selector en el panel de configuración; prueba de humo del cambio de idioma. F3 sigue en 0,5 (falta ver el modo automático en el editor); sin cambio de puntaje | 2,9 % |
| 2026-10-21 | Editor SQL propio de DB Client, entrega 1 (nuevo S14, 4 pts, en 0,5): editor opcional con barra de listas de conexión y base y botones de icono, CodeMirror y resultados en la misma pestaña; ajuste `dbclient.sqlEditor.openByDefault`; total 122 → 126 | 4,4 % |
| 2026-10-21 | Editor de texto SQL/Redis (S1): el CodeLens de la primera línea queda solo con el selector de conexión y base; ejecutar el archivo, ejecutar la selección, copiar, pegar y guardar pasan a la barra de título, y el resto al menú `…` (conectar/desconectar y cancelar según el estado del editor activo); ▶ Run vuelve a la primera sentencia. Sin cambio de puntaje; v0.19.0 | 4,4 % |
| 2026-10-21 | Al desconectar, la conexión se contrae en el árbol (C2); botón **■ Cancel** en la barra de título del editor mientras corre una consulta y en el CodeLens de la sentencia en curso, que muestra **Ejecutando…** (S1). Cancelar ya no se reporta como error de SQL (la salida dice `Cancelada` y cuántas sentencias quedaron sin ejecutar), un cancelar durante la conexión detiene antes de la primera sentencia y la siguiente ejecución espera a que el cancelar llegue al servidor. Verificado en PostgreSQL: pruebas de integración (cancelar y volver a ejecutar en la misma sesión con su estado, cancelar en reposo no afecta la siguiente) y de humo (lente Cancel → cancelar en 28 ms → ejecutar de nuevo; id nuevo del nodo al desconectar). MySQL, SQL Server y Oracle tienen las mismas pruebas pero sus contenedores no estaban arriba; SQLite no se puede cancelar (ejecución síncrona). Sin verificar a mano en Cursor. Sin cambio de puntaje | 4,4 % |
