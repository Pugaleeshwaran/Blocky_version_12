import sys
import os
import numpy as np

def get_input_info(onnx_path):
    import onnx
    import numpy as np
    model = onnx.load(onnx_path)
    for inp in model.graph.input:
        shape = []
        for dim in inp.type.tensor_type.shape.dim:
            shape.append(dim.dim_value if dim.dim_value > 0 else 1)
        
        dtype = inp.type.tensor_type.elem_type
        np_dtype = np.uint8 if dtype == 2 else np.float32
        
        print(f"Model input name:  {inp.name}")
        print(f"Model input shape: {shape}")
        print(f"Model input dtype: {np_dtype}")
        return shape, np_dtype
    return [1, 256], np.float32

def compile_model(onnx_path, kmodel_path):
    print(f"Input ONNX:  {onnx_path}")
    print(f"ONNX size:   {os.path.getsize(onnx_path)} bytes")

    import nncase

    input_shape, input_dtype = get_input_info(onnx_path)
    print(f"Using input shape: {input_shape}, dtype: {input_dtype}")

    with open(onnx_path, 'rb') as f:
        model_content = f.read()

    compile_options = nncase.CompileOptions()
    compile_options.target     = 'k230'
    compile_options.dump_ir    = False
    compile_options.dump_asm   = False
    compile_options.preprocess = False

    compiler = nncase.Compiler(compile_options)

    import_options = nncase.ImportOptions()
    try:
        compiler.import_onnx(model_content, import_options)
        print("ONNX import OK")
    except Exception as e:
        print(f"ONNX import failed: {e}")
        sys.exit(1)

    try:
        ptq_options = nncase.PTQTensorOptions()
        ptq_options.samples_count = 10

        def calib_gen():
            for i in range(10):
                if input_dtype == np.uint8:
                    data = np.random.randint(0, 256, size=input_shape, dtype=np.uint8)
                else:
                    data = np.random.rand(*input_shape).astype(np.float32)
                print(f"Calib sample {i+1} shape: {data.shape}, dtype: {data.dtype}")
                yield [data]

        ptq_options.set_tensor_data(calib_gen())
        compiler.use_ptq(ptq_options)
        print("PTQ OK")
    except Exception as e:
        print(f"PTQ failed: {e}")
        sys.exit(1)

    try:
        compiler.compile()
        print("Compile OK")
    except Exception as e:
        print(f"Compile failed: {e}")
        sys.exit(1)

    try:
        kmodel = compiler.gencode_tobytes()
        print(f"kmodel generated: {len(kmodel)} bytes")
    except Exception as e:
        print(f"gencode failed: {e}")
        sys.exit(1)

    if len(kmodel) < 100:
        print(f"ERROR: kmodel too small ({len(kmodel)} bytes)")
        sys.exit(1)

    if b'Protobuf' in kmodel[:200] or b'Error' in kmodel[:200]:
        print("ERROR: kmodel contains error text")
        sys.exit(1)

    with open(kmodel_path, 'wb') as f:
        f.write(kmodel)

    print(f"kmodel saved OK: {os.path.getsize(kmodel_path)} bytes")

if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("Usage: python nncase_compile.py <onnx_path> <kmodel_path>")
        sys.exit(1)
    compile_model(sys.argv[1], sys.argv[2])