import type { PipeTransform } from "@nestjs/common";
import { ValidationError } from "../../application/errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parametro de rota que precisa ser UUID; senao 400 no formato padrao de erro. */
export class UuidParam implements PipeTransform<string, string> {
  constructor(private readonly field: string) {}

  transform(value: string): string {
    if (!UUID.test(value)) {
      throw new ValidationError([{ field: this.field, message: "deve ser um UUID" }]);
    }
    return value.toLowerCase();
  }
}
