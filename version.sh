#!/bin/bash

set -e                                                        # Detener la ejecución en caso de error

HELP=false
MAYOR=false
MINOR=false
RELEASE=false
INDEX=2
CURRENT_VERSION=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0") # Obtener la versión actual de Git
NEW_VERSION=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0") # Obtener la versión actual de Git

# Parsear opciones
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --h|--help)
        HELP=true
        shift
        ;;                             # Activar la bandera si se proporciona --help
        --m|--major)
        MAYOR=true
        shift
        ;;                          # Activar la bandera si se proporciona --major
        --n|--minor)
        MINOR=true
        shift
        ;;                          # Activar la bandera si se proporciona --minor
        --r|--request)
        RELEASE=true
        shift
        ;;                            # Activar la bandera si se proporciona --push
        *) echo "Opción desconocida: $1"; exit 1 ;;
    esac
done

# Mostrar las opciones elegidas
echo "Opciones elegidas:"
[[ "$MAYOR" == true ]] && echo " - Major: Activado"
[[ "$MINOR" == true ]] && echo " - Minor: Activado"

build_version() {
  # Obtiene la última etiqueta
  latest_tag=$(git describe --tags --abbrev=0 2>/dev/null)

  # Divide la etiqueta en componentes usando el punto como delimitador
  IFS='.' read -r -a version_parts <<< "${latest_tag#v}"

  if [ "$MAYOR" == true ]; then
    # Si se proporciona la opción --major, incrementa el valor de la posición 0
    version_parts[0]=$((version_parts[0] + 1))
    version_parts[1]=0
    version_parts[2]=0

    NEW_VERSION="v${version_parts[0]}.${version_parts[1]}.${version_parts[2]}"    
  elif [ "$MINOR" == true ]; then
    # Si se proporciona la opción --minor, incrementa el valor de la posición 1        
    version_parts[1]=$((version_parts[1] + 1))
    version_parts[2]=0

    NEW_VERSION="v${version_parts[0]}.${version_parts[1]}.${version_parts[2]}"    
  else
    # Incrementa el valor de la posición 2
    version_parts[2]=$((version_parts[2] + 1))

    # Reconstruye la nueva versión (X.Y.Z) y prepende la 'v' al principio
    NEW_VERSION="v${version_parts[0]}.${version_parts[1]}.${version_parts[2]}"    
  fi
}

update_version() {
  echo "Versión actual: $CURRENT_VERSION"
  echo "Nueva versión: $NEW_VERSION"
  echo "Etiquetando con: $NEW_VERSION"

  sed -i "" "s/$CURRENT_VERSION/$NEW_VERSION/g" README.md
  
  git tag -a "$NEW_VERSION" -m "$NEW_VERSION"
  git push origin --tags

  echo "Etiqueta creada y enviada a Git"
}

help() {
  echo "Uso: ./version.sh [opciones]"
  echo "Incrementa la versión de la etiqueta de Git"
  echo ""
  echo "Opciones:"
  echo "  --h, --help     Muestra este mensaje de ayuda"
  echo "  --m, --major    Incrementa la versión mayor"
  echo "  --n, --minor    Incrementa la versión menor"
  echo "  --r, --release  Incrementa la versión de la revisión"
  exit 0
}

if [ "$HELP" == true ]; then
  help
elif [ "$CURRENT_VERSION" == "v0.0.0" ]; then
  NEW_VERSION="v0.0.1"
  update_version
elif [ "$RELEASE" == true ]; then
  build_version
  update_version
else
  help
fi

# Línea en blanco al final