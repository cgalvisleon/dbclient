<img src="media/icon.png" width="72" align="right" alt="DB Client">

# DB Client

[English](README.md) · [Español](README.es.md)

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/cgalvisleon.dbclient?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=cgalvisleon.dbclient) [![Open VSX version](https://img.shields.io/open-vsx/v/cgalvisleon/dbclient)](https://open-vsx.org/extension/cgalvisleon/dbclient) [![Open VSX downloads](https://img.shields.io/open-vsx/dt/cgalvisleon/dbclient)](https://open-vsx.org/extension/cgalvisleon/dbclient) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Um cliente de banco de dados gratuito e de código aberto (MIT) para VS Code e Cursor: PostgreSQL, MySQL, SQL Server, Oracle, SQLite, Redis e NATS em uma única árvore de conexões, sem instalar mais nada.

<!-- GIF (visão geral, ~8 s): a árvore com vários motores, executar uma consulta, aba de resultados. Salve como img/screenshots/overview.gif e referencie como
![DB Client](https://raw.githubusercontent.com/cgalvisleon/dbclient/main/img/screenshots/overview.gif) — URL absoluta para aparecer no Open VSX e no Marketplace. -->

## Instalação

Procure **DB Client** (`cgalvisleon.dbclient`) na visão de Extensões. O VS Code instala a partir do [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=cgalvisleon.dbclient); Cursor, VSCodium e Windsurf a partir do [Open VSX](https://open-vsx.org/extension/cgalvisleon/dbclient). Para instalar offline, baixe `dbclient-<versão>.vsix` dos [GitHub Releases](https://github.com/cgalvisleon/dbclient/releases) (ou gere-o com `npm install && npm run package`), abra a Paleta de Comandos (`Ctrl/Cmd+Shift+P`), execute **Extensions: Install from VSIX…** e escolha o arquivo. Requer VS Code 1.90 ou mais recente; conexões SQLite precisam de um editor com Node 22.13 ou mais recente (Cursor, VS Code 1.101+). Não são necessários módulos nativos nem clientes de banco de dados.

## O que é

Um cliente de banco de dados dentro do editor. Conexões PostgreSQL, MySQL, SQL Server, Oracle, SQLite, Redis e NATS ficam em uma única árvore, e cada tipo abre seu próprio editor: um editor SQL inspirado no NetBeans, um editor de comandos Redis com visualizador de valores e um console NATS.

É gratuito, sem plano pago, e tem licença MIT. Os drivers são JavaScript puro, então não é preciso módulos nativos, Oracle Instant Client nem ferramentas de linha de comando de bancos. Redis e NATS (com JetStream) ficam ao lado dos motores SQL. A interface está em inglês, espanhol e português do Brasil. Este guia usa os nomes dos comandos em inglês; na interface em português eles aparecem traduzidos.

As conexões são salvas uma vez por usuário e compartilhadas por todas as janelas e workspaces. Senhas e tokens vão para o armazenamento de segredos do editor, nunca para o arquivo de configurações. Um botão **Show** ao lado de cada campo de senha mostra o que você digita.

## Funcionalidades

| Área | O que você tem |
|---|---|
| Conexões | Uma árvore para todos os motores; criar, editar, duplicar, excluir, testar, conectar e desconectar a partir de um formulário. |
| Pastas | Agrupe conexões em pastas aninhadas; criar, renomear, excluir (o conteúdo sobe um nível), mover com **Move to Folder…** ou arrastando e soltando. |
| Armazenamento | `connections.json` no nível do usuário; segredos no armazenamento de segredos do editor. |
| Settings and About | O botão ⚙ no título da visão abre um painel com onde a extensão guarda seus dados (pasta de armazenamento, `connections.json`, histórico de consultas, arquivos SQL salvos) com **Copy** e **Open folder**, as configurações `dbclient.*` atuais comparadas aos padrões, o ambiente (editor, Node.js, suporte a SQLite) e os links do autor no GitHub. |
| SSL/TLS | PostgreSQL, MySQL, Oracle (TCPS), Redis e NATS: **disable**, **require** (criptografado) ou **verify-full** (certificado e nome do host), com arquivo de CA, certificado e chave de cliente (com senha). SQL Server: **Encrypt** confiando ou não no certificado, e um arquivo de CA. |
| Túnel SSH | Todos os motores exceto SQLite podem se conectar através de um servidor SSH, com senha ou chave privada (com senha) e uma impressão digital opcional da chave do host. |
| Idiomas | Inglês, espanhol e português do Brasil. Por padrão a interface segue o idioma de exibição do editor; `dbclient.language` (ou o seletor em **Configurações e sobre**) escolhe um. |
| Exportar / importar | **Export Connections…** grava todas as conexões, uma pasta (na pasta) ou as conexões selecionadas (em uma conexão) em um arquivo JSON sem senhas; **Import Connections…** mescla (as existentes são mantidas, as idênticas ignoradas) ou substitui a lista, e em uma pasta importa para dentro dela. |
| Ícones e cores | Cada conexão pode escolher seu ícone na árvore (banco de dados, servidor, nuvem, com engrenagem ou lupa) e uma de 7 cores (azul, verde, vermelho, laranja, roxo, amarelo, cinza) na seção **Appearance** do formulário — por exemplo, vermelho para produção. As pastas também recebem cor com **Change Color…**. |
| Explorador (SQL) | Bancos/esquemas → tabelas, views, funções, procedures, triggers, índices (Oracle: packages, sequences) → colunas com tipo, PK e NOT NULL. |
| Editor SQL | A primeira linha dos editores SQL e Redis mostra `Connection:` com a conexão e o banco como lista suspensa (clique para escolher uma conexão e depois um banco; pede confirmação antes de trocar), seguida da barra do editor SQL do DB Client como botões de ícone (executar arquivo, instrução ou seleção, ■ Cancel durante a execução, conectar/desconectar, histórico, salvar, copiar, colar, exportar, importar) e, por último, um que abre o arquivo no editor SQL do DB Client; ▶ Run acima de cada instrução (durante a execução, ■ Cancel). Os botões da barra de título executam o arquivo ou a instrução do cursor (ou a seleção), conectam ou desconectam, salvam, copiam e colam, e ■ Cancel enquanto uma consulta roda; seu menu `…` executa a seleção, troca a conexão, abre o histórico, exporta e importa. A lista de conexões mostra cada conexão com sua pasta (`Trabalho / Prod / prod-pg`). |
| Editor SQL do DB Client | Editor opcional no estilo do NetBeans para arquivos `.sql` (**Abrir com…** ou o botão do título do editor): uma barra com listas suspensas reais para a conexão (agrupadas por pasta) e o banco, botões de ícone maiores para todas as ações, o SQL com realce de sintaxe e os resultados abaixo na mesma aba, com um divisor que pode ser arrastado. O arquivo continua sendo um documento normal (salvar, desfazer, Git). |
| Arquivos SQL salvos | Cada conexão SQL, e cada um de seus bancos, tem um nó **SQL** com seus próprios arquivos `.sql`; abrir um deles o vincula a essa conexão e banco. Novo, renomear, excluir, **Save** (em arquivos com alterações não salvas) e salvar ali a consulta atual. |
| Locais SQL | Vincule pastas existentes de arquivos `.sql` (por exemplo, o `sql/` de um repositório) a uma conexão e navegue por elas com suas subpastas; escolha onde os novos arquivos são salvos. Os caminhos aceitam `~` e `${workspaceFolder}`; desvincular nunca exclui arquivos. |
| Divisão de instruções | `;` em todos, mais `GO` (SQL Server), `DELIMITER` (MySQL), `/` e blocos PL/SQL (Oracle), corpos `$$` (PostgreSQL), triggers (SQLite). |
| Resultados | Painel inferior com **Output** primeiro e uma aba por conjunto de resultados, mantidas entre execuções (até 50; com **Keep tabs** desligado são limpas a cada execução) e reordenáveis arrastando, paginação, ordenação, seleção de linhas, copiar como TSV, exportar para CSV, JSON ou Excel (`.xlsx`, números e datas como valores do Excel). |
| Saída SQL | Cada instrução registrada com tempo, linhas lidas/afetadas e erros; os erros levam à linha e coluna no editor e aparecem sublinhados. **Clear** esvazia o registro e numera as consultas a partir de 1 de novo. |
| Histórico de consultas | **Query History…** lista o que foi executado em cada conexão SQL ou Redis, do mais recente ao mais antigo, com banco, hora, duração e linhas ou erro; pesquise, insira uma instrução no editor ou abra-a em um novo. |
| Ações de tabela | Em uma tabela ou view: **Open Data**, **Open SQL**, **Show Structure** (colunas e índices), **Show DDL** e **Generate SQL** → SELECT, INSERT, UPDATE, DELETE em um novo editor. |
| Atualizar e excluir | **Refresh** em uma conexão, banco, esquema, pasta ou tabela a lê de novo, para que esquemas e tabelas criados ou excluídos em outro lugar apareçam; DDL executado no editor atualiza a conexão sozinho. **Drop…** remove uma tabela ou view (CASCADE no PostgreSQL, CASCADE CONSTRAINTS no Oracle) e, onde o motor os tem, um esquema: esquemas do PostgreSQL e SQL Server, bancos do MySQL, usuários do Oracle. |
| Menu da linha | Clique com o botão direito em uma célula do resultado: **Copy Value**, **Copy Row** (TSV com cabeçalho), **Copy Row as JSON**; em resultados de uma tabela, **Generate INSERT/UPDATE/DELETE from Row** abre a instrução com os valores da linha em um novo editor vinculado à conexão. |
| Edição na grade | Resultados de uma única tabela com chave primária são editáveis: edite células, adicione e exclua linhas, defina NULL e depois **Commit** (uma transação, pela chave primária) ou **Cancel**. |
| Autocompletar SQL | Palavras-chave, tipos e funções do dialeto da conexão; com a conexão aberta, seus esquemas, tabelas, views e colunas, resolvendo os aliases da consulta. O mesmo no editor de texto e no editor SQL do DB Client. |
| Explorador Redis | Bancos com contagem de chaves → chaves agrupadas por separador (`:`) com seu tipo, usando `SCAN`. |
| Editor Redis | Arquivos `.redis`, um comando por linha; autocompletar comandos, opções e chaves existentes; pede confirmação antes de `FLUSHDB`/`FLUSHALL`. |
| Valores Redis | Visualizador/editor para string, hash, list, set, sorted set e stream; TTL, renomear e excluir. |
| URL JDBC do Oracle | Conexões Oracle podem usar **Connect by → JDBC URL** em vez de host e serviço: `jdbc:oracle:thin:@//host:1521/service`, `@host:1521:SID`, `tcps://…`, `(DESCRIPTION=…)` ou um alias do tnsnames.ora com `?TNS_ADMIN=<pasta>`. Usuário e senha dentro da URL vão para seus campos, então a senha nunca é salva em texto puro. Funciona com SSL e com o túnel SSH. |
| NATS | Conecte sem autenticação ou com usuário/senha, token, seed NKey ou um arquivo `.creds`. Publique com headers, request/reply, assine com curingas `*`/`>` e queue groups, lista de mensagens ao vivo; streams e consumers do JetStream na árvore. |

## Uso

**Adicionar uma conexão.** Abra a visão **DB Client** na barra de atividades, pressione **+**, escolha o tipo, preencha o formulário, pressione **Test** e depois **Save**. Expanda a conexão para navegar por ela.

**Conectar com segurança.** No formulário da conexão, a seção **SSL / TLS** define o modo e os arquivos PEM; **verify-full** verifica o certificado contra o arquivo de CA (ou as CAs do sistema) e o nome do host. A seção **SSH tunnel** alcança um banco visível apenas a partir de um bastion host: preencha o host SSH, o usuário e uma senha ou chave privada, e mantenha **Host** e **Port** como o banco é visto a partir desse servidor. Cole a impressão digital `SHA256:` do servidor (`ssh-keygen -lf` na chave pública do host) para recusar qualquer outro servidor.

```text
Host: db.internal   Port: 5432   SSL: verify-full   CA certificate: ~/certs/ca.pem
SSH tunnel: private key   SSH host: bastion.example.com   SSH user: deploy   Private key: ~/.ssh/id_ed25519
```

**Levar conexões para outra máquina.** No menu **…** da visão escolha **Export Connections…** (ou **Export Connections…** em uma pasta, só para essa pasta) e salve o arquivo `.json`; ele contém pastas, conexões e locais SQL, nunca senhas. Na outra máquina escolha **Import Connections…**, selecione o arquivo e **Merge** ou **Replace**, depois informe as senhas com **Edit Connection**. Restaurar um backup na mesma máquina mantém o id de cada conexão, então sua senha salva e seus arquivos SQL voltam a funcionar.

**Ver onde ficam seus dados.** Pressione **⚙ Settings and About** no título da visão. **Persistence** lista a pasta de armazenamento, o arquivo de conexões, o histórico de consultas e a pasta de arquivos SQL salvos, cada um com **Copy** e **Open folder**; as senhas não estão ali, e sim no armazenamento de segredos do editor. **Settings** mostra cada valor `dbclient.*`, onde está definido e seu padrão (**Open in Settings** para alterá-los), e **About** tem a versão e o perfil, o repositório e as issues do autor no GitHub.

**Trocar o idioma.** O DB Client usa por padrão o idioma do editor. Para usar outro, abra **⚙ Configurações e sobre** (**Settings and About**), escolha-o em **Idioma da interface** — ou defina `dbclient.language` como `en`, `es` ou `pt-br` — e pressione **Recarregar janela**. Os títulos dos comandos nos menus e o editor de configurações sempre seguem o idioma do editor; é uma limitação do VS Code.

**Compartilhar uma conexão ou preencher uma pasta.** Clique com o botão direito em uma conexão (ou em várias selecionadas) → **Export Connections…** para salvar só essas, sem pastas nem senhas. Clique com o botão direito em uma pasta → **Import Connections…** para mesclar um arquivo nessa pasta: suas conexões e pastas ficam dentro dela.

**Diferenciar conexões.** No formulário da conexão, **Appearance** mostra as formas e cores dos ícones com uma pré-visualização; escolha, por exemplo, o banco com engrenagem em vermelho para produção e o verde para desenvolvimento. **Automatic** mantém o ícone do motor. Para colorir uma pasta, clique com o botão direito nela → **Change Color…**.

**Organizar com pastas.** Pressione o botão **New Folder** no título da visão (ou **New Folder** em uma pasta para criar uma subpasta). Arraste conexões ou pastas para uma pasta, ou use **Move to Folder…**; solte-as em um espaço vazio para devolvê-las ao nível superior. **Add Connection** em uma pasta cria a conexão dentro dela, e o campo **Folder** do formulário a altera depois.

**Consultar um banco SQL.** Clique em **New Query** em uma conexão ou banco. Escreva SQL e pressione `Ctrl/Cmd+Enter` para executar a instrução sob o cursor (ou a seleção), ou `Ctrl/Cmd+Shift+Enter` para executar o arquivo inteiro:

```sql
select id, name from customers where created_at > now() - interval '7 days';
update customers set active = false where id = 42;
```

<!-- GIF (sql-editor.gif): Ctrl/Cmd+Enter em uma instrução, aba de resultados, exportar para Excel. ![Editor SQL](https://raw.githubusercontent.com/cgalvisleon/dbclient/main/img/screenshots/sql-editor.gif) -->

Cada consulta abre uma aba em **DB Client → Results**, depois das anteriores; a aba **Output**, sempre a primeira, lista cada instrução com seu tempo e número de linhas. Arraste uma aba para reordená-la (solte-a sobre **Output** para torná-la o primeiro resultado); clique com o botão do meio ou em **×** para fechá-la. **CSV**, **JSON** e **Excel** na barra da aba exportam todas as suas linhas na ordem atual.

**Guardar consultas por conexão.** Expanda uma conexão SQL e use **New SQL File** em seu nó **SQL**, ou pressione **Save to Connection's SQL Folder** no título do editor para guardar a consulta atual. Os arquivos abrem já vinculados à sua conexão. Eles ficam no armazenamento da extensão, uma pasta por conexão; defina `dbclient.sqlFolder` para guardá-los em outro lugar, como uma pasta sincronizada ou versionada.

**Vincular pastas de arquivos SQL.** Use **Link SQL Folder…** em uma conexão ou em seu nó **SQL** e escolha uma ou mais pastas. Se a pasta estiver dentro do projeto aberto, você pode salvá-la como `${workspaceFolder}/…`, e a mesma conexão mostra a pasta `sql/` do projeto que estiver aberto. Cada pasta vinculada aparece em **SQL** com suas subpastas (pastas ocultas, `.git` e `node_modules` são ignoradas). Arquivos abertos de uma pasta vinculada são executados nessa conexão; quando duas conexões vinculam a mesma pasta, vence a pasta mais específica e um empate é perguntado uma vez. **Set Save Location for SQL Files…** escolhe onde **New SQL File** e **Save to Connection's SQL Folder** gravam. A seção **SQL files** do formulário da conexão edita as mesmas configurações:

```text
Save new files in:  ${workspaceFolder}/sql
Linked folders:     ${workspaceFolder}/sql
                    ~/projects/reports
```

**Ver e trocar a conexão do editor.** A primeira linha de cada editor SQL e Redis mostra a conexão e o banco em que ele é executado, no estilo do NetBeans; clique nela (ou na barra de status) para escolher outra conexão e depois, em uma conexão SQL com vários bancos, o banco. Se o editor já tinha uma conexão, um diálogo pede confirmação antes de trocar. ▶ Run aparece acima de cada instrução.

```
Connection: 🛢 prod-pg / sales ▾ | ⏩ | ▶ | ☰ | 🔌 | 🕘 | 💾 | ⧉ | 📋 | ⇪ | ⇩ | ▣
▶ Run
select id, name from customers;
```

A barra de título do editor tem botões para **executar o arquivo inteiro**, **executar a instrução** do cursor (ou a seleção), **conectar** ou **desconectar**, **salvar** na pasta SQL da conexão, **copiar** (a seleção ou o arquivo inteiro) e **colar**; enquanto uma consulta roda, um botão **■ Cancel** a interrompe (a instrução em execução também mostra **Executando…** e **■ Cancel**). Seu menu `…` tem o resto: executar a seleção, trocar a conexão, histórico de consultas, exportar para um arquivo, importar um arquivo no cursor e abrir o arquivo no editor SQL do DB Client. A lista de conexões mostra cada conexão com a pasta onde está (`Trabalho / Prod / prod-pg`). A primeira linha repete essas ações como botões de ícone (os mesmos da barra do editor SQL do DB Client; passe o ponteiro para ver o que fazem), e seu último botão abre o arquivo no editor SQL do DB Client. Desligue a linha da conexão com `dbclient.connectionLens`.

**Usar o editor SQL do DB Client.** Em um editor `.sql` pressione o botão **Open in DB Client SQL Editor** (**Abrir no editor SQL do DB Client**) da barra de título (ou clique com o botão direito na aba → **Reopen Editor With…** → **Editor SQL do DB Client**). A aba mostra uma barra, o SQL e seus próprios resultados:

```
Conexão: [prod-pg (PostgreSQL) ▾]  Banco de dados: [sales ▾] │ ⏩ ▶ ☰ ■ │ 🔌 🕘 💾 │ ⧉ 📋 ⇪ ⇩ │      📄
select id, name from customers;
═════════════════════ (arraste para redimensionar) ═════════════════════
Output │ select id, name from…
```

Escolha a conexão e o banco nas listas (os bancos aparecem quando a conexão está aberta), execute com os botões ou com `Ctrl/Cmd+Enter` (a instrução do cursor ou a seleção) e `Ctrl/Cmd+Shift+Enter` (tudo). Os resultados, a edição na grade e as exportações funcionam como no painel inferior, mas cada editor SQL tem os seus (a aba **DB Client** do painel inferior fica oculta até que Redis, Show Structure ou o editor de texto mostrem algo ali). Passe o ponteiro sobre um botão para ver o que ele faz (e seu atalho). O botão de layout move os resultados para baixo, para cima, à esquerda ou à direita do SQL. 📄 volta ao editor de texto. É opcional: ative `dbclient.sqlEditor.openByDefault` para abrir ali as consultas novas, os arquivos SQL salvos da árvore e as ações de tabela (uma consulta salva ou renomeada a partir dele continua nele de qualquer forma); para usá-lo com todos os `.sql`, escolha **Configure default editor for '*.sql'** na lista de **Reopen Editor With…**. O autocompletar sugere o mesmo que no editor de texto (ao digitar, depois de `.` ou de um espaço, ou com `Ctrl+Espaço`); os erros sublinhados no texto continuam só no editor de texto (chegam em uma próxima versão).

**Guardar arquivos SQL por banco.** Expanda um banco na árvore: seu primeiro filho é **SQL**, com os arquivos desse banco. **New SQL File** no banco ou em seu nó **SQL** cria um ali, e ao abri-lo ele é executado nessa conexão e banco. Um arquivo com alterações não salvas mostra `● unsaved` e um botão **Save** na árvore.

**Trabalhar com uma tabela.** Clique com o botão direito em uma tabela na árvore. **Open Data** executa `SELECT * FROM` a tabela; **Open SQL** abre essa mesma consulta em um novo editor sem executá-la; **Show Structure** lista suas colunas e índices no painel Results; **Show DDL** e **Generate SQL** abrem a instrução em um novo editor vinculado à conexão. Esses editores, o SQL gerado a partir de uma linha do resultado e as instruções que o Query History abre são editores de texto (editores SQL do DB Client se `dbclient.sqlEditor.openByDefault` estiver ativado).

**Atualizar ou excluir objetos.** Se alguém alterou o banco fora da extensão, pressione o botão de atualizar na conexão, banco, esquema ou pasta (ou **Refresh** em seu menu de contexto) para lê-lo de novo. Para remover uma tabela, view ou esquema, clique com o botão direito → **Drop…**: o diálogo mostra a instrução `DROP` e, no PostgreSQL e no Oracle, oferece **Drop with CASCADE**; esquemas também pedem que você digite o nome. A árvore é atualizada após a exclusão.

**Transformar uma linha em SQL.** Clique com o botão direito em uma célula de um resultado e escolha **Generate UPDATE from Row**. Um novo editor vinculado à mesma conexão abre com os valores da linha como literais e um `WHERE` pela chave primária:

```sql
UPDATE public.items
SET name = 'O''Brien',
    active = TRUE
WHERE id = 7;
```

Quando o resultado não inclui a chave primária, o `WHERE` usa todas as colunas e um comentário pede que você verifique se ele corresponde a uma única linha. **Copy Value**, **Copy Row** e **Copy Row as JSON** no mesmo menu copiam para a área de transferência. **Clear** na aba **Output** esvazia o registro e numera as próximas consultas a partir de 1 de novo.

**Editar dados na grade.** Em um resultado que lê uma tabela e inclui sua chave primária, clique duas vezes em uma célula (ou pressione `F2`), digite e pressione `Enter`; `Tab` vai para a próxima coluna e `Escape` descarta. **+ Row** adiciona uma linha (células não tocadas mantêm seu DEFAULT), **Delete** marca as linhas selecionadas e **NULL** limpa a célula com foco. **Commit** salva tudo em uma transação e recarrega as linhas; se uma linha mudou nesse meio-tempo, nada é salvo. Resultados de views, joins ou sem a chave mostram um selo **read-only** com o motivo.

<!-- GIF (grid-editing.gif): editar uma célula, + Row, Commit. ![Edição na grade](https://raw.githubusercontent.com/cgalvisleon/dbclient/main/img/screenshots/grid-editing.gif) -->

**Completar nomes de tabelas e colunas.** Com a conexão aberta, digite `select * from ` para ver suas tabelas, ou um alias e um ponto para ver as colunas dessa tabela:

```sql
select o.id, o.total, c.name
from orders o join customers c on c.id = o.customer_id
where o.   -- sugere as colunas de orders
```

**Reutilizar uma consulta anterior.** Clique com o botão direito em uma conexão SQL ou Redis, ou use o menu **…** do título do editor, e escolha **Query History…**. Digite para filtrar, por exemplo `orders`. Enter insere a instrução no editor ativo quando ele é executado na mesma conexão e, caso contrário, a abre em um novo editor vinculado à sua conexão e banco; os botões do item a abrem em um novo editor ou a copiam. Defina `dbclient.historySize` como `0` para desligar o histórico.

**Executar um lote do SQL Server ou um bloco Oracle.** Separe lotes com `GO` e blocos PL/SQL com `/`:

```sql
create or alter procedure dbo.touch as
begin
  update dbo.items set updated_at = sysdatetime();
end
GO
exec dbo.touch;
```

**Trabalhar com Redis.** Clique em **New Query** em uma conexão Redis ou em um de seus bancos (`db0`, `db1`…) e digite um comando por linha; `Ctrl/Cmd+Enter` executa a linha atual ou as linhas selecionadas:

```redis
HSET user:1 name "Ana Maria" age 30
HGETALL user:1
EXPIRE user:1 3600
```

Clique em uma chave na árvore para abrir seu visualizador de valores e editá-la.

<!-- GIF (redis.gif): executar comandos, abrir um hash no visualizador de valores. ![Redis](https://raw.githubusercontent.com/cgalvisleon/dbclient/main/img/screenshots/redis.gif) -->

**Publicar e assinar com NATS.** Clique em **Open NATS Console** em uma conexão NATS. Assine `orders.>` e publique em `orders.created` com um payload JSON e headers como `X-Trace: abc`; as mensagens recebidas aparecem na lista, e selecionar uma mostra seu payload e headers.

<!-- GIF (nats.gif): assinar orders.>, publicar, lista de mensagens. ![NATS](https://raw.githubusercontent.com/cgalvisleon/dbclient/main/img/screenshots/nats.gif) -->

## Configurações

| Configuração | Padrão | Descrição |
|---|---|---|
| `dbclient.maxRows` | 5000 | Linhas lidas por instrução; resultados maiores são truncados. |
| `dbclient.pageSize` | 100 | Linhas por página na grade de resultados. |
| `dbclient.codeLens` | true | Mostrar ▶ Run acima de cada instrução SQL. |
| `dbclient.connectionLens` | true | Mostrar a conexão e o banco do editor na primeira linha dos editores SQL e Redis. |
| `dbclient.sqlFolder` | (vazio) | Pasta para os arquivos `.sql` salvos, uma subpasta por conexão; vazio usa o armazenamento da extensão. |
| `dbclient.historySize` | 500 | Entradas mantidas no histórico de consultas de cada conexão; `0` o desliga. Comandos que podem conter credenciais (`AUTH`, `HELLO`, `ACL`, `MIGRATE`, `CONFIG`) nunca são registrados. |
| `dbclient.sqlEditor.openByDefault` | false | Abrir as consultas novas e os arquivos SQL salvos da árvore no editor SQL do DB Client em vez do editor de texto. |
| `dbclient.sqlEditor.resultsPosition` | bottom | Onde o editor SQL do DB Client mostra seus resultados em relação ao SQL: `bottom`, `top`, `left` ou `right` (também com o botão de layout da sua barra). |
| `dbclient.language` | auto | Idioma da interface: `auto` (igual ao editor), `en`, `es` ou `pt-br`. |

## Desenvolvimento

```bash
npm install
npm run build        # empacota em dist/
npm test             # testes unitários; os de integração rodam quando as variáveis DBCLIENT_* estão definidas
npm run test:smoke   # executa a extensão dentro de um VS Code baixado
npm run package      # gera o .vsix
```

Para testar SSL e SSH, `eval "$(scripts/tls-fixture.sh start)"` e `eval "$(scripts/ssh-fixture.sh start)"` iniciam servidores descartáveis com Docker (certificados e chaves novos) e exportam suas variáveis `DBCLIENT_TLS_*` / `DBCLIENT_SSH_*`; `stop` os remove. Com todos os servidores no ar, execute `npm run test:integration` (um arquivo de teste por vez). As traduções ficam em `l10n/bundle.l10n.<es|pt-br>.json` e `package.nls.<es|pt-br>.json`; `npx tsx test/unit/l10nKeys.ts l10n/bundle.l10n.pt-br.json` lista os textos que ainda faltam.

Para testar os modos de autenticação do NATS, `eval "$(scripts/nats-auth-fixture.sh start)"` inicia servidores descartáveis (usuário/senha, NKey, token e `.creds`, com Docker) e exporta suas variáveis `DBCLIENT_NATS_AUTH_*`; `scripts/nats-auth-fixture.sh stop` os remove.

### Publicação

Aumente `version` em `package.json`, adicione sua seção ao `CHANGELOG.md`, faça o commit e depois envie uma tag com a mesma versão:

```bash
git tag v0.19.0 && git push origin main v0.19.0
```

O workflow **Release** (`.github/workflows/release.yml`) executa os testes, gera o `.vsix`, anexa-o a um GitHub Release com as notas do changelog e o publica no Open VSX e no VS Code Marketplace quando os segredos do repositório `OVSX_PAT` e `VSCE_PAT` existem. Desta máquina: `OVSX_PAT=… npm run publish:ovsx` e `VSCE_PAT=… npm run publish:vsce`.

Pressione **F5** nesta pasta para iniciar um Extension Development Host. Requisitos e progresso são acompanhados em [spec.md](spec.md).
