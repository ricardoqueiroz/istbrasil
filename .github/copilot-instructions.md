# AI Coding Instructions for istbrasil.org.br

## Architecture Overview
This is a hybrid web application with a modern Angular frontend and a lightweight Node.js/Express backend, co-existing with legacy PHP components.
- **Frontend**: Angular 20 (Sakai NG template) with PrimeNG and Tailwind CSS. Located in `src/app`.
- **Backend (Node)**: Express.js server entry point is `server.js` at root. API routes are located in `src/routes/` (JS files).
- **Backend (Legacy PHP)**: Existing PHP admin and support scripts in `development/` and `html/`. Maintain if requested but prefer Node/Angular for new features.
- **Database**: MySQL. Connection logic in `src/config/db.js`.

## Codebase Patterns & Conventions
- **Backend Location**: Unlike standard practices, Node.js backend routes and config currently reside in `src/routes` and `src/config` alongside Angular source. Be careful to distinguish `.js` (backend) from `.ts` (frontend) files in `src/`.
- **Angular Stack**: Uses Standalone Components (Angular 19+ style). PrimeNG is the primary UI library; Tailwind is used for utility classes.
- **Data Access**: `mysql2` with promise support is used for database interactions.

## Key Files & Directories
- `server.js`: Main Express server entry point.
- `src/app/`: Angular frontend application code.
- `src/routes/`: Express API route definitions (Javascript).
- `src/config/db.js`: Database configuration and connection pool.
- `database/`: SQL schemas and views.
- `istdbadmin/`: Legacy PHP admin interface.

## Development Workflow
- **Frontend**: Run `ng serve` to start the Angular dev server (default port 4200).
- **Backend**: Run `node server.js` to start the API server (default port 3000).
- **Database Testing**: Run `node test-db.js` to verify connectivity.

## Environment
- **OS**: Windows (IIS environment).
- **Paths**: Project root is `c:\inetpub\wwwroot\istbrasil.org.br`. Use absolute paths or standard node module resolution.
