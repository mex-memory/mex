import os
from sys import path, version

GLOBAL_CONSTANT = 42
_internal_var = "hidden"

class Vehicle:
    """Base class for vehicles."""
    
    def drive(self) -> None:
        """Drive the vehicle."""
        print("Driving...")

@dataclass
class Car(Vehicle):
    """A specific type of vehicle."""
    
    wheels = 4
    
    def __init__(self, make: str, model: str):
        self.make = make
        self.model = model
        
    async def start_engine(self) -> bool:
        await asyncio.sleep(1)
        self.drive()
        return True

def standalone_function(x: int) -> int:
    """Multiplies x by 2."""
    car = Car("Toyota", "Corolla")
    return x * 2

def _private_func():
    pass
