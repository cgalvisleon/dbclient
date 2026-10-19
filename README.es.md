<img src="media/icon.png" width="72" align="right" alt="DB Client">

# DB Client

[English](README.md)

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/cgalvisleon.dbclient?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=cgalvisleon.dbclient) [![Open VSX version](https://img.shields.io/open-vsx/v/cgalvisleon/dbclient)](https://open-vsx.org/extension/cgalvisleon/dbclient) [![Open VSX downloads](https://img.shields.io/open-vsx/dt/cgalvisleon/dbclient)](https://open-vsx.org/extension/cgalvisleon/dbclient) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Un cliente de bases de datos gratuito y de código abierto (MIT) para VS Code y Cursor: PostgreSQL, MySQL, SQL Server, Oracle, SQLite, Redis y NATS en un solo árbol de conexiones, sin instalar nada más.

<!-- GIF (vista general, ~8 s): el árbol con varios motores, ejecutar una consulta, pestaña de resultados. Guárdalo como img/screenshots/overview.gif y enlázalo como
![DB Client](https://raw.githubusercontent.com/cgalvisleon/dbclient/main/img/screenshots/overview.gif) — URL absoluta para que se vea en Open VSX y en el Marketplace. -->

## Instalación

Busca **DB Client** (`cgalvisleon.dbclient`) en la vista de extensiones. VS Code la instala desde el [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=cgalvisleon.dbclient); Cursor, VSCodium y Windsurf desde [Open VSX](https://open-vsx.org/extension/cgalvisleon/dbclient). Para instalarla sin conexión, descarga `dbclient-<versión>.vsix` de los [GitHub Releases](https://github.com/cgalvisleon/dbclient/releases) (o genéralo con `npm install && npm run package`), abre la paleta de comandos (`Ctrl/Cmd+Shift+P`), ejecuta **Extensions: Install from VSIX…** y elige el archivo. Requiere VS Code 1.90 o superior; las conexiones SQLite requieren un editor con Node 22.13 o superior (Cursor, VS Code 1.101+). No necesita módulos nativos ni clientes de bases de datos.

## Qué es

Un cliente de bases de datos dentro del editor. Las conexiones a PostgreSQL, MySQL, SQL Server, Oracle, SQLite, Redis y NATS están en un solo árbol, y cada tipo abre su propio editor: un editor SQL inspirado en el de NetBeans, un editor de comandos Redis con visor de valores y una consola NATS.

Es gratuito, sin versión de pago, y tiene licencia MIT. Los drivers son JavaScript puro, así que no necesita módulos nativos, Oracle Instant Client ni herramientas de línea de comandos de las bases. Redis y NATS (con JetStream) están junto a los motores SQL, y la interfaz está en inglés y en español.

Las conexiones se guardan una sola vez por usuario y se comparten entre todas las ventanas y espacios de trabajo. Las contraseñas y los tokens van al almacenamiento seguro del editor, nunca al archivo de configuración. El botón **Show** (**Ver**) junto a cada campo de contraseña muestra lo que escribes.

## Funcionalidades

| Área | Qué ofrece |
|---|---|
| Conexiones | Un solo árbol para todos los motores; crear, editar, duplicar, eliminar, probar, conectar y desconectar desde un formulario. |
| Carpetas | Agrupar conexiones en carpetas anidadas; crear, renombrar, eliminar (el contenido sube un nivel), mover con **Move to Folder…** o arrastrando y soltando. |
| Almacenamiento | `connections.json` a nivel de usuario; secretos en el almacenamiento seguro del editor. |
| Configuración y acerca de | El botón ⚙ del título de la vista abre un panel con dónde guarda la extensión sus datos (carpeta de almacenamiento, `connections.json`, historial de consultas, archivos SQL guardados) con **Copiar** y **Abrir carpeta**, la configuración `dbclient.*` actual frente a sus valores por defecto, el entorno (editor, Node.js, soporte de SQLite) y los enlaces de GitHub del autor. |
| SSL/TLS | PostgreSQL, MySQL, Oracle (TCPS), Redis y NATS: **desactivado**, **requerido** (cifrado) o **verificar todo** (certificado y nombre del host), con archivo de CA, certificado y clave del cliente (con frase). SQL Server: **Cifrar** confiando o no en el certificado, y un archivo de CA. |
| Túnel SSH | Todos los motores menos SQLite pueden conectarse a través de un servidor SSH, con contraseña o clave privada (con frase) y una huella opcional de la llave del host. |
| Idiomas | Inglés y español, según el idioma de la interfaz del editor. |
| Exportar / importar | **Export Connections…** guarda todas las conexiones, una carpeta (sobre la carpeta) o las conexiones seleccionadas (sobre una conexión) en un archivo JSON sin contraseñas; **Import Connections…** lo fusiona (conserva las existentes y omite las idénticas) o reemplaza la lista, y sobre una carpeta importa dentro de ella. |
| Iconos y colores | Cada conexión puede elegir su icono en el árbol (base de datos, servidor, nube, con engranaje o con lupa) y uno de 7 colores (azul, verde, rojo, naranja, morado, amarillo, gris) en la sección **Apariencia** del formulario; por ejemplo, rojo para producción. Las carpetas también cambian de color con **Change Color…** (**Cambiar color…**). |
| Explorador (SQL) | Bases/esquemas → tablas, vistas, funciones, procedimientos, triggers, índices (Oracle: paquetes, secuencias) → columnas con tipo, PK y NOT NULL. |
| Editor SQL | Selector de conexión en la barra de estado y en la barra del editor; ejecutar la sentencia bajo el cursor, la selección o el archivo completo; ▶ Run sobre cada sentencia; cancelar. |
| Archivos SQL guardados | Cada conexión SQL tiene un nodo **SQL** con sus propios archivos `.sql`; al abrir uno queda vinculado a la conexión. Crear, renombrar, eliminar y guardar ahí la consulta actual. |
| Ubicaciones SQL | Vincular a una conexión carpetas existentes con archivos `.sql` (por ejemplo la carpeta `sql/` de un repositorio) y recorrerlas con sus subcarpetas; elegir dónde se guardan los archivos nuevos. Las rutas aceptan `~` y `${workspaceFolder}`; desvincular nunca borra archivos. |
| División de sentencias | `;` en todos los motores, más `GO` (SQL Server), `DELIMITER` (MySQL), `/` y bloques PL/SQL (Oracle), cuerpos `$$` (PostgreSQL) y triggers (SQLite). |
| Resultados | Panel inferior con una pestaña por conjunto de resultados, opción de conservar pestañas, paginación, orden, selección de filas, copiar como TSV y exportar a CSV, JSON o Excel (`.xlsx`, con números y fechas como valores de Excel). |
| Salida SQL | Cada sentencia queda registrada con su tiempo, filas traídas/afectadas y errores; los errores llevan a la línea y columna del editor y quedan subrayados. |
| Historial de consultas | **Query History…** lista lo que se ejecutó en cada conexión SQL o Redis, lo más reciente primero, con base, hora, duración y filas o error; se puede buscar, insertar una sentencia en el editor o abrirla en uno nuevo. |
| Acciones sobre tablas | En una tabla o vista: **Open Data**, **Open SQL**, **Show Structure** (columnas e índices), **Show DDL** y **Generate SQL** → SELECT, INSERT, UPDATE, DELETE en un editor nuevo. |
| Actualizar y eliminar | **Refresh** sobre una conexión, base, esquema, carpeta o tabla la vuelve a leer, así aparecen los esquemas y tablas creados o borrados por fuera; el DDL ejecutado desde el editor actualiza la conexión solo. **Drop…** elimina una tabla o vista (CASCADE en PostgreSQL, CASCADE CONSTRAINTS en Oracle) y, donde el motor los tiene, un esquema: esquemas de PostgreSQL y SQL Server, bases de MySQL, usuarios de Oracle. |
| Edición en la grilla | Los resultados de una sola tabla con clave primaria se pueden editar: celdas, agregar y eliminar filas, poner NULL, y luego **Commit** (una transacción, por clave primaria) o **Cancel**. |
| Autocompletado SQL | Palabras clave, tipos y funciones del dialecto de la conexión; con la conexión abierta, sus esquemas, tablas, vistas y columnas, resolviendo los alias de la consulta. |
| Explorador Redis | Bases con su número de llaves → llaves agrupadas por separador (`:`) con su tipo, usando `SCAN`. |
| Editor Redis | Archivos `.redis`, un comando por línea; autocompletado de comandos, opciones y llaves existentes; pide confirmación antes de `FLUSHDB`/`FLUSHALL`. |
| Valores Redis | Visor/editor de string, hash, list, set, sorted set y stream; TTL, renombrar y eliminar. |
| URL JDBC de Oracle | Las conexiones Oracle pueden usar **Connect by → JDBC URL** en vez de host y servicio: `jdbc:oracle:thin:@//host:1521/servicio`, `@host:1521:SID`, `tcps://…`, `(DESCRIPTION=…)` o un alias de tnsnames.ora con `?TNS_ADMIN=<carpeta>`. Si la URL trae usuario y contraseña, pasan a sus campos, así la contraseña nunca se guarda en texto plano. Funciona con SSL y con el túnel SSH. |
| NATS | Conexión sin autenticación o con usuario/clave, token, seed NKey o archivo `.creds`. Publicar con headers, request/reply, suscribirse con comodines `*`/`>` y grupos de cola, lista de mensajes en vivo; streams y consumers de JetStream en el árbol. |

## Uso

Con el editor en español, los comandos y menús aparecen traducidos; en esta guía se nombran en inglés, como en la versión original.

**Agregar una conexión.** Abre la vista **DB Client** en la barra de actividad, pulsa **+**, elige el tipo, completa el formulario, pulsa **Test** y luego **Save**. Expande la conexión para explorarla.

**Conectar de forma segura.** En el formulario de la conexión, la sección **SSL / TLS** define el modo y los archivos PEM; **verificar todo** comprueba el certificado contra el archivo de CA (o las CA del sistema) y el nombre del host. La sección **Túnel SSH** llega a una base que solo se ve desde un servidor intermedio (bastión): completa el host SSH, el usuario y una contraseña o clave privada, y deja **Host** y **Puerto** como los ve la base desde ese servidor. Pega la huella `SHA256:` del servidor (`ssh-keygen -lf` sobre su llave pública de host) para rechazar cualquier otro servidor.

```text
Host: db.internal   Puerto: 5432   SSL: verificar todo   Certificado de la CA: ~/certs/ca.pem
Túnel SSH: clave privada   Host SSH: bastion.example.com   Usuario SSH: deploy   Clave privada: ~/.ssh/id_ed25519
```

**Llevar las conexiones a otra máquina.** En el menú **…** de la vista elige **Export Connections…** (o **Export Connections…** sobre una carpeta para exportar solo esa carpeta) y guarda el archivo `.json`; contiene carpetas, conexiones y ubicaciones SQL, nunca contraseñas. En la otra máquina elige **Import Connections…**, selecciona el archivo y **Merge** o **Replace**, y luego ingresa las contraseñas con **Edit Connection**. Al restaurar una copia en la misma máquina se conserva el id de cada conexión, así que su contraseña guardada y sus archivos SQL vuelven a funcionar.

**Ver dónde están tus datos.** Pulsa **⚙ Settings and About** (**Configuración y acerca de**) en el título de la vista. **Persistencia** lista la carpeta de almacenamiento, el archivo de conexiones, el historial de consultas y la carpeta de los archivos SQL guardados, cada una con **Copiar** y **Abrir carpeta**; las contraseñas no están ahí sino en el almacén de secretos del editor. **Configuración** muestra cada valor `dbclient.*`, dónde está definido y su valor por defecto (**Abrir en Configuración** para cambiarlos), y **Acerca de** tiene la versión y el perfil de GitHub, el repositorio y los reportes de problemas del autor.

**Compartir una conexión o llenar una carpeta.** Clic derecho sobre una conexión (o varias seleccionadas) → **Export Connections…** para guardar solo esas, sin carpetas ni contraseñas. Clic derecho sobre una carpeta → **Import Connections…** para fusionar un archivo dentro de esa carpeta: sus conexiones y carpetas quedan adentro.

**Distinguir las conexiones.** En el formulario de conexión, **Apariencia** muestra las formas y los colores del icono con vista previa; elige, por ejemplo, la base de datos con engranaje en rojo para producción y la verde para desarrollo. **Automático** conserva el icono del motor. Para colorear una carpeta, clic derecho sobre ella → **Change Color…** (**Cambiar color…**).

**Organizar con carpetas.** Pulsa el botón **New Folder** en el título de la vista (o **New Folder** sobre una carpeta para crear una subcarpeta). Arrastra conexiones o carpetas sobre una carpeta, o usa **Move to Folder…**; suéltalas en un espacio vacío para devolverlas al nivel superior. **Add Connection** sobre una carpeta crea la conexión dentro de ella, y el campo **Folder** del formulario permite cambiarla después.

**Consultar una base SQL.** Pulsa **New Query** sobre una conexión o una base. Escribe SQL y pulsa `Ctrl/Cmd+Enter` para ejecutar la sentencia bajo el cursor (o la selección), o `Ctrl/Cmd+Shift+Enter` para ejecutar el archivo completo:

```sql
select id, name from customers where created_at > now() - interval '7 days';
update customers set active = false where id = 42;
```

<!-- GIF (sql-editor.gif): Ctrl/Cmd+Enter sobre una sentencia, pestaña de resultados, exportar a Excel. ![Editor SQL](https://raw.githubusercontent.com/cgalvisleon/dbclient/main/img/screenshots/sql-editor.gif) -->

Cada consulta abre una pestaña en **DB Client → Results**; la pestaña **Output** lista cada sentencia con su tiempo y número de filas. **CSV**, **JSON** y **Excel** en la barra de la pestaña exportan todas sus filas en el orden actual.

**Guardar consultas por conexión.** Expande una conexión SQL y usa **New SQL File** sobre su nodo **SQL**, o pulsa **Save to Connection's SQL Folder** en la barra del editor para conservar la consulta actual. Los archivos se abren ya vinculados a su conexión. Se guardan en el almacenamiento de la extensión, una carpeta por conexión; configura `dbclient.sqlFolder` para guardarlos en otro lugar, como una carpeta sincronizada o versionada.

**Vincular carpetas de archivos SQL.** Usa **Link SQL Folder…** sobre una conexión o su nodo **SQL** y elige una o varias carpetas. Si la carpeta está dentro del proyecto abierto puedes guardarla como `${workspaceFolder}/…`, así la misma conexión muestra la carpeta `sql/` del proyecto que tengas abierto. Cada carpeta vinculada aparece bajo **SQL** con sus subcarpetas (se omiten las ocultas, `.git` y `node_modules`). Los archivos abiertos desde una carpeta vinculada se ejecutan contra esa conexión; si dos conexiones vinculan la misma carpeta, gana la carpeta más específica y en caso de empate se pregunta una vez. **Set Save Location for SQL Files…** elige dónde escriben **New SQL File** y **Save to Connection's SQL Folder**. La sección **SQL files** del formulario de conexión edita lo mismo:

```text
Save new files in:  ${workspaceFolder}/sql
Linked folders:     ${workspaceFolder}/sql
                    ~/projects/reports
```

**Trabajar con una tabla.** Haz clic derecho sobre una tabla del árbol. **Open Data** ejecuta `SELECT * FROM` la tabla; **Open SQL** abre esa misma consulta en un editor nuevo sin ejecutarla; **Show Structure** lista sus columnas e índices en el panel Results; **Show DDL** y **Generate SQL** abren la sentencia en un editor nuevo vinculado a la conexión.

**Actualizar o eliminar objetos.** Si alguien cambió la base por fuera de la extensión, pulsa el botón de actualizar sobre la conexión, base, esquema o carpeta (o **Refresh** en su menú contextual) para leerla de nuevo. Para quitar una tabla, vista o esquema, clic derecho → **Drop…**: el diálogo muestra la sentencia `DROP` y, en PostgreSQL y Oracle, ofrece **Drop with CASCADE**; los esquemas además piden escribir su nombre. El árbol se actualiza después de eliminar.

**Editar datos en la grilla.** En un resultado que lee una sola tabla e incluye su clave primaria, haz doble clic en una celda (o pulsa `F2`), escribe y pulsa `Enter`; `Tab` pasa a la columna siguiente y `Escape` descarta. **+ Row** agrega una fila (las celdas sin tocar conservan su DEFAULT), **Delete** marca las filas seleccionadas y **NULL** vacía la celda enfocada. **Commit** guarda todo en una transacción y recarga las filas; si una fila cambió mientras tanto, no se guarda nada. Los resultados de vistas, joins o sin la clave muestran una etiqueta **read-only** con el motivo.

<!-- GIF (grid-editing.gif): editar una celda, + Row, Commit. ![Edición en la grilla](https://raw.githubusercontent.com/cgalvisleon/dbclient/main/img/screenshots/grid-editing.gif) -->

**Completar nombres de tablas y columnas.** Con la conexión abierta, escribe `select * from ` para ver sus tablas, o un alias y un punto para ver las columnas de esa tabla:

```sql
select o.id, o.total, c.name
from orders o join customers c on c.id = o.customer_id
where o.   -- sugiere las columnas de orders
```

**Reutilizar una consulta anterior.** Haz clic derecho sobre una conexión SQL o Redis, o usa el menú **…** de la barra del editor, y elige **Query History…**. Escribe para filtrar, por ejemplo `orders`. Enter inserta la sentencia en el editor activo cuando este corre sobre la misma conexión; si no, la abre en un editor nuevo vinculado a su conexión y base. Los botones de cada elemento la abren en un editor nuevo o la copian. Configura `dbclient.historySize` en `0` para apagar el historial.

**Ejecutar un lote de SQL Server o un bloque de Oracle.** Separa los lotes con `GO` y los bloques PL/SQL con `/`:

```sql
create or alter procedure dbo.touch as
begin
  update dbo.items set updated_at = sysdatetime();
end
GO
exec dbo.touch;
```

**Trabajar con Redis.** Pulsa **New Query** sobre una conexión Redis o sobre una de sus bases (`db0`, `db1`…) y escribe un comando por línea; `Ctrl/Cmd+Enter` ejecuta la línea actual o las líneas seleccionadas:

```redis
HSET user:1 name "Ana Maria" age 30
HGETALL user:1
EXPIRE user:1 3600
```

Haz clic en una llave del árbol para abrir su visor de valores y editarla.

<!-- GIF (redis.gif): ejecutar comandos, abrir un hash en el visor de valores. ![Redis](https://raw.githubusercontent.com/cgalvisleon/dbclient/main/img/screenshots/redis.gif) -->

**Publicar y suscribirse con NATS.** Pulsa **Open NATS Console** sobre una conexión NATS. Suscríbete a `orders.>` y publica en `orders.created` con un payload JSON y headers como `X-Trace: abc`; los mensajes recibidos aparecen en la lista y, al seleccionar uno, se ven su payload y sus headers.

<!-- GIF (nats.gif): suscribirse a orders.>, publicar, lista de mensajes. ![NATS](https://raw.githubusercontent.com/cgalvisleon/dbclient/main/img/screenshots/nats.gif) -->

## Configuración

| Opción | Valor por defecto | Descripción |
|---|---|---|
| `dbclient.maxRows` | 5000 | Filas traídas por sentencia; los resultados más grandes se truncan. |
| `dbclient.pageSize` | 100 | Filas por página en la grilla de resultados. |
| `dbclient.codeLens` | true | Mostrar ▶ Run sobre cada sentencia SQL. |
| `dbclient.sqlFolder` | (vacío) | Carpeta de los archivos `.sql` guardados, una subcarpeta por conexión; vacío usa el almacenamiento de la extensión. |
| `dbclient.historySize` | 500 | Entradas que se guardan en el historial de cada conexión; `0` lo apaga. Los comandos que pueden llevar credenciales (`AUTH`, `HELLO`, `ACL`, `MIGRATE`, `CONFIG`) nunca se registran. |

## Desarrollo

```bash
npm install
npm run build        # empaqueta en dist/
npm test             # pruebas unitarias; las de integración corren si hay variables DBCLIENT_*
npm run test:smoke   # ejecuta la extensión dentro de un VS Code descargado
npm run package      # genera el .vsix
```

Para probar SSL y SSH, `eval "$(scripts/tls-fixture.sh start)"` y `eval "$(scripts/ssh-fixture.sh start)"` levantan servidores temporales con Docker (certificados y llaves nuevos) y exportan sus variables `DBCLIENT_TLS_*` / `DBCLIENT_SSH_*`; `stop` los elimina. Con todos los servidores arriba, ejecuta `npm run test:integration` (los archivos de prueba de uno en uno). Las traducciones están en `l10n/bundle.l10n.es.json` y `package.nls.es.json`; `npx tsx test/unit/l10nKeys.ts l10n/bundle.l10n.es.json` lista los textos que falten.

Para probar las autenticaciones de NATS, `eval "$(scripts/nats-auth-fixture.sh start)"` levanta servidores temporales (usuario/clave, NKey, token y `.creds`, con Docker) y exporta sus variables `DBCLIENT_NATS_AUTH_*`; `scripts/nats-auth-fixture.sh stop` los elimina.

### Publicar

Sube `version` en `package.json`, agrega su sección en `CHANGELOG.md`, haz commit y empuja un tag con la misma versión:

```bash
git tag v0.14.0 && git push origin main v0.14.0
```

El workflow **Release** (`.github/workflows/release.yml`) corre las pruebas, genera el `.vsix`, lo adjunta a un GitHub Release con las notas del changelog y lo publica en Open VSX y en el VS Code Marketplace cuando existen los secretos del repositorio `OVSX_PAT` y `VSCE_PAT`. Desde esta máquina: `OVSX_PAT=… npm run publish:ovsx` y `VSCE_PAT=… npm run publish:vsce`.

Pulsa **F5** en esta carpeta para abrir un Extension Development Host. Los requisitos y el avance están en [spec.md](spec.md).
